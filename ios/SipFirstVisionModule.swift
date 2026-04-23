import Foundation
import Vision
import UIKit

// ─────────────────────────────────────────────────────────────────────────────
// Detection pipeline — v4 (multiplicative scoring + background consistency)
// ─────────────────────────────────────────────────────────────────────────────
//
//  Signal 1 – Face          VNDetectFaceRectanglesRequest
//                           → establishes spatial "above / below" reference
//
//  Signal 2 – Hand          VNDetectHumanHandPoseRequest  (8 landmarks)
//                           → confirms user is holding something
//
//  Signal 3 – Rect shape    VNDetectRectanglesRequest
//                           → finds a tall narrow rectangle near the hand,
//                             below the face (glass silhouette)
//
//  Signal 4 – Transparency  pixel-level analysis on the rectangle interior
//                           → strict rejection of mugs / phones / bottles
//
//  Final decision:
//    glassDetected = faceDetected
//                  ∧ handBelowFace
//                  ∧ combined  > 0.08    ← multiplicative threshold
//                  ∧ varScore  > 0.25    ← background must show through
//                  ∧ colScore  > 0.20    ← column profile must be non-flat
//
// ── Scoring model: MULTIPLICATIVE + SOFT PENALTIES ───────────────────────────
//
//   combined = satScore × varScore × colScore × edgeScore × vGradScore
//            × bgScore × penaltyMul
//
//   satScore normalisation range widened to 0.50 (was 0.30).
//   Previously S = 0.307 → satScore = 0, destroying the product even when
//   var/col/edge were all 1.00.  Now S = 0.307 → satScore = 0.39.
//
//   satScore    low mean saturation         → rules out coloured bottles / juice
//   varScore    lightness std-dev           → background visible through glass
//   colScore    per-column brightness std   → cylindrical glass-wall profile
//   edgeScore   edge columns > centre       → specular highlights on glass walls
//   vGradScore  vertical lightness range    → liquid/meniscus gradient
//   bgScore     inside ≈ surrounding ring   → transparent (bgScore = 0 at bgDiff ≥ 0.18)
//   penaltyMul  product of soft penalties   → [0.40^5, 1.0] ≈ [0.010, 1.0]
//
//   brightScore is computed and logged only; the DARK soft penalty covers it.
//
// ── Extreme hard gates (combined = 0) — only physical impossibilities ─────────
//
//   meanLightness   < 0.08    pitch-black region (covered lens, total darkness)
//   lightnessStdDev < 0.010   zero variance → solid colour patch
//   meanSaturation  > 0.55    deeply saturated (satScore also → 0 at S > 0.50)
//   satStdDev       > 0.25    wildly inconsistent saturation
//
// ── Soft-gate penalties — applied as a multiplier, NOT combined = 0 ───────────
//
//   meanLightness   ∈ [0.08, 0.22]   dim scene    → [DARK×p],     p ∈ [0.40, 1.0]
//   lightnessStdDev ∈ [0.010, 0.055] low variance → [UNIFORM×p],  p ∈ [0.40, 1.0]
//   satStdDev       ∈ [0.11, 0.25]   slight pattern→ [PATCHY×p],  p ∈ [0.45, 1.0]
//   columnStdDev    ∈ [0.005, 0.030] flat profile  → [FLAT_C×p],  p ∈ [0.40, 1.0]
//   verticalRange   ∈ [0.003, 0.018] low gradient  → [FLAT_V×p],  p ∈ [0.45, 1.0]
//
// ─────────────────────────────────────────────────────────────────────────────

@objc(SipFirstVisionModule)
class SipFirstVisionModule: NSObject {

  // MARK: – Internal types

  private struct PixelSample {
    let lightness:  Float   // (max+min)/2 of RGB  — HLS lightness
    let saturation: Float   // (max-min)/max of RGB — HSV saturation
  }

  private struct TransparencyResult {
    let isTransparent: Bool
    let satScore:      Float   // colourlessness
    let brightScore:   Float   // not-too-dark (logged only, not in product)
    let varScore:      Float   // lightness spread — background through glass
    let edgeScore:     Float   // edge columns brighter than centre
    let colScore:      Float   // per-column brightness variation
    let vGradScore:    Float   // vertical lightness gradient
    let bgScore:       Float   // background consistency (inside ≈ ring)
    let bgDiff:        Float   // |innerMean − ringMean| raw value, for logging
    let combined:      Float   // multiplicative product of 6 scores
    let rejectionTag:  String  // hard-gate tags that fired; empty when none
    let debug:         String  // full numeric calibration line
  }

  // MARK: – RN entry point

  @objc func analyzeImage(
    _ imagePath: String,
    resolver: @escaping RCTPromiseResolveBlock,
    rejecter: @escaping RCTPromiseRejectBlock
  ) {
    DispatchQueue.global(qos: .userInitiated).async {

      // ── Tuning knobs ────────────────────────────────────────────────────────
      let pointMinConf:         Float = 0.08   // min hand-landmark confidence
      let handRectProximity:    Float = 0.55   // max ΔX between hand and rect centre
      let rectMinConf:          Float = 0.10   // low — transparent glass has faint edges
      let rectMinSize:          Float = 0.02
      let rectMinAspect:        Float = 0.15   // allows tall narrow glasses
      let rectMaxAspect:        Float = 3.00
      let rectQuadTolerance:    Float = 50     // degrees, generous for cylindrical glass
      let transparencyMinScore: Float = 0.08   // multiplicative threshold (6-factor product)

      // Per-score minimums — prevent a single inflated signal from carrying
      // an otherwise weak candidate over the combined threshold.
      let varScoreMin:  Float = 0.25   // background must visibly show through
      let colScoreMin:  Float = 0.20   // column brightness profile must be non-flat

      // ── Load image ──────────────────────────────────────────────────────────
      let cleanPath = imagePath.hasPrefix("file://")
        ? String(imagePath.dropFirst(7))
        : imagePath

      guard let uiImage = UIImage(contentsOfFile: cleanPath),
            let cgImage = uiImage.cgImage else {
        resolver(["faceDetected": false, "glassDetected": false,
                  "topLabels": ["img_load_fail"]])
        return
      }

      let orientation = CGImagePropertyOrientation(uiImage.imageOrientation)
      let handler = VNImageRequestHandler(
        cgImage: cgImage, orientation: orientation, options: [:]
      )

      // ── Vision requests ─────────────────────────────────────────────────────
      let faceReq = VNDetectFaceRectanglesRequest()

      let handReq = VNDetectHumanHandPoseRequest()
      handReq.maximumHandCount = 2

      let rectReq = VNDetectRectanglesRequest()
      rectReq.minimumAspectRatio  = VNAspectRatio(rectMinAspect)
      rectReq.maximumAspectRatio  = VNAspectRatio(rectMaxAspect)
      rectReq.minimumSize         = rectMinSize
      rectReq.quadratureTolerance = VNDegrees(rectQuadTolerance)
      rectReq.minimumConfidence   = rectMinConf
      rectReq.maximumObservations = 20

      var faceDetected  = false
      var glassDetected = false
      var calibInfo: [String] = []

      do {
        try handler.perform([faceReq, handReq, rectReq])

        // ── Signal 1 · Face ─────────────────────────────────────────────────
        let faces = faceReq.results ?? []
        faceDetected = !faces.isEmpty
        calibInfo.append("faces:\(faces.count)")

        guard let face = faces.first else {
          resolver(["faceDetected": false, "glassDetected": false,
                    "topLabels": calibInfo])
          return
        }

        // Vision coords: origin bottom-left, y upward.
        // faceFloor = lowest y of face rect → everything with smaller y is "below face".
        let faceFloor = Float(face.boundingBox.minY)
        calibInfo.append("faceFloor:\(String(format:"%.2f", faceFloor))")

        // ── Signal 2 · Hand ─────────────────────────────────────────────────
        // Check 8 landmarks — wrist alone is often off-frame in selfie mode.
        let checkJoints: [VNHumanHandPoseObservation.JointName] = [
          .wrist,
          .indexTip, .indexPIP,
          .middleTip, .middlePIP,
          .ringTip, .littleTip, .thumbTip
        ]

        var handBelowFace = false
        var handX: Float  = 0.5    // fallback: image centre-X
        let hands = handReq.results ?? []
        calibInfo.append("hands:\(hands.count)")

        outerLoop:
        for hand in hands {
          for joint in checkJoints {
            guard let pt = try? hand.recognizedPoint(joint) else { continue }
            if pt.confidence >= pointMinConf && Float(pt.location.y) < faceFloor {
              handBelowFace = true
              handX = Float(pt.location.x)
              calibInfo.append(
                "handPt conf:\(String(format:"%.2f",pt.confidence))" +
                " x:\(String(format:"%.2f",pt.location.x))" +
                " y:\(String(format:"%.2f",pt.location.y))"
              )
              break outerLoop
            }
          }
        }
        calibInfo.append("handGate:\(handBelowFace)")

        // ── Signal 3 · Rectangle candidates ────────────────────────────────
        //
        // Vision ranks by its own confidence — transparent glass often scores
        // lower than solid background furniture (subtle edges → lower confidence).
        //
        // Strategy:
        //   1. Collect all rects passing geometric gates.
        //   2. Run transparency analysis on the 8 closest to the hand.
        //   3. Pick the highest combined-score one — opaque rects trip hard
        //      gates and score 0, so the actual glass wins.
        let rects = rectReq.results ?? []
        calibInfo.append("rects:\(rects.count)")

        var geoCandidates: [(rect: CGRect, distToHand: Float)] = []

        for rect in rects {
          let bb   = rect.boundingBox
          let midX = Float(bb.midX)
          let midY = Float(bb.midY)

          // Must be spatially below the face
          if midY >= faceFloor                         { continue }
          // Reject huge background slabs
          if bb.width > 0.75 || bb.height > 0.75      { continue }
          // Reject noise dots
          if bb.width < 0.03 || bb.height < 0.03      { continue }
          // Glass width gate: a drinking glass at 25–60 cm ≤ 28 % of frame width
          if bb.width > 0.28                           { continue }
          // Reject landscape shapes — a glass is always taller than wide
          if Float(bb.width) > Float(bb.height) * 1.5 { continue }
          // Must be near the detected hand
          let distToHand = abs(midX - handX)
          if handBelowFace && distToHand > handRectProximity { continue }

          geoCandidates.append((bb, distToHand))
        }

        // Sort by closeness to hand; analyse up to 8 nearest candidates.
        geoCandidates.sort { $0.distToHand < $1.distToHand }

        // ── Signal 4 · Pixel-level transparency (best of candidates) ────────
        var bestRect:  CGRect?             = nil
        var bestTR:    TransparencyResult? = nil

        for (rect, _) in geoCandidates.prefix(8) {
          let tr = SipFirstVisionModule.analyzeTransparency(
            cgImage: cgImage, normRect: rect, threshold: transparencyMinScore
          )
          if bestTR == nil || tr.combined > bestTR!.combined {
            bestRect = rect
            bestTR   = tr
          }
        }

        if let bb = bestRect, let tr = bestTR {

          // ── Calibration: geometry ──────────────────────────────────────────
          calibInfo.append(
            "rectHit cx:\(String(format:"%.2f",bb.midX))" +
            " cy:\(String(format:"%.2f",bb.midY))" +
            " w:\(String(format:"%.2f",bb.width))" +
            " h:\(String(format:"%.2f",bb.height))" +
            " ar:\(String(format:"%.2f",bb.height/bb.width))"
          )

          // ── Calibration: per-score breakdown ───────────────────────────────
          calibInfo.append(
            "combined:\(String(format:"%.4f",tr.combined))" +
            " sat:\(String(format:"%.2f",tr.satScore))" +
            " var:\(String(format:"%.2f",tr.varScore))" +
            " col:\(String(format:"%.2f",tr.colScore))" +
            " edge:\(String(format:"%.2f",tr.edgeScore))" +
            " vGrad:\(String(format:"%.2f",tr.vGradScore))" +
            " bg:\(String(format:"%.2f",tr.bgScore))" +
            " bgDiff:\(String(format:"%.3f",tr.bgDiff))" +
            " bright:\(String(format:"%.2f",tr.brightScore))"
          )

          // ── Calibration: raw pixel metrics ────────────────────────────────
          calibInfo.append(tr.debug)

          // ── Calibration: hard-gate tags ────────────────────────────────────
          if !tr.rejectionTag.isEmpty {
            calibInfo.append("hardRej:\(tr.rejectionTag)")
          }

          // ── Final decision ─────────────────────────────────────────────────
          // All conditions must hold simultaneously:
          //   1. Face detected        (Signal 1 spatial anchor)
          //   2. Hand below face      (Signal 2 grip confirmation)
          //   3. Multiplicative score > 0.08 — ALL six pixel signals must
          //      contribute; any near-zero factor collapses the product.
          //   4. varScore  > 0.25    — background must visibly show through.
          //   5. colScore  > 0.20    — column profile must be non-flat.
          //   Conditions 4–5 prevent a very high satScore (nearly colourless
          //   object) from masking weak transparency and cylindrical-shape signals.
          let scoreGatesPass =
            tr.combined > transparencyMinScore &&
            tr.varScore > varScoreMin          &&
            tr.colScore > colScoreMin

          glassDetected = faceDetected && handBelowFace && scoreGatesPass

          calibInfo.append(
            "decision face:\(faceDetected)" +
            " hand:\(handBelowFace)" +
            " scoreOK:\(scoreGatesPass)" +
            " (prod:\(String(format:"%.4f",tr.combined))>0.08" +
            " var:\(String(format:"%.2f",tr.varScore))>0.25" +
            " col:\(String(format:"%.2f",tr.colScore))>0.20)" +
            " → glass:\(glassDetected)"
          )

        } else {
          calibInfo.append("noRectCandidate")
          calibInfo.append("decision → glass:false")
        }

      } catch {
        calibInfo.append("err:\(error.localizedDescription)")
      }

      resolver([
        "faceDetected": faceDetected,
        "glassDetected": glassDetected,
        "topLabels": calibInfo
      ])
    }
  }

  // MARK: – Transparency analysis

  /// Pixel-level analysis of normRect to determine if it looks like a
  /// transparent drinking glass.
  ///
  /// Scoring model: MULTIPLICATIVE with soft-gate penalty multiplier.
  ///
  ///   combined = satScore × varScore × colScore × edgeScore × vGradScore × bgScore
  ///            × penaltyMul
  ///
  /// penaltyMul (range 0.4–1.0) is the product of up to five independent soft
  /// penalties, one per borderline condition.  Each penalty degrades the score
  /// gradually rather than zeroing it, so a frame with one weak signal still has
  /// a chance to pass while one with many weak signals is correctly suppressed.
  ///
  /// Only four extreme conditions are kept as hard gates (combined = 0):
  ///   meanL   < 0.08   pitch-black region — physically impossible for a glass
  ///   stdDevL < 0.010  zero variance — solid-colour patch, not glass
  ///   meanS   > 0.55   deeply saturated — also zeroed by satScore naturally
  ///   stdDevS > 0.25   wildly inconsistent saturation — extreme patterned object
  ///
  /// bgScore acts as its own continuous gate: bgScore = 0 when bgDiff ≥ 0.18,
  /// which already collapses the product for opaque objects.
  ///
  /// normRect: Vision normalised coordinates (origin bottom-left, y upward).
  private static func analyzeTransparency(
    cgImage: CGImage,
    normRect: CGRect,
    threshold: Float
  ) -> TransparencyResult {

    let sampleW = 20
    let sampleH = 40

    // ── Inner region (the candidate rectangle itself) ────────────────────────
    let samples = sampleRegion(
      cgImage: cgImage, normRect: normRect,
      sampleW: sampleW, sampleH: sampleH
    )

    guard samples.count >= 60 else {
      return TransparencyResult(
        isTransparent: false,
        satScore: 0, brightScore: 0, varScore: 0,
        edgeScore: 0, colScore: 0, vGradScore: 0,
        bgScore: 0, bgDiff: 0, combined: 0,
        rejectionTag: "[SAMPLE_FAIL]",
        debug: "sampleFail(\(samples.count))"
      )
    }

    let n = Float(samples.count)

    // ── Mean lightness + saturation ─────────────────────────────────────────
    var sumL: Float = 0, sumS: Float = 0
    for s in samples { sumL += s.lightness; sumS += s.saturation }
    let meanL = sumL / n
    let meanS = sumS / n

    // ── Lightness standard deviation ────────────────────────────────────────
    // High → background visible through the glass.
    // Low  → uniform opaque surface (white mug, phone back).
    var sumSqL: Float = 0
    for s in samples { let d = s.lightness - meanL; sumSqL += d * d }
    let stdDevL = (sumSqL / n).squareRoot()

    // ── Saturation standard deviation ───────────────────────────────────────
    // Transparent glass: achromatic background shows through → low stdDevS.
    // Speckled ceramic: cream base + coloured speckles → high stdDevS even when
    // meanS is low. Core discriminator for patterned mugs.
    var sumSqS: Float = 0
    for s in samples { let d = s.saturation - meanS; sumSqS += d * d }
    let stdDevS = (sumSqS / n).squareRoot()

    // ── Per-column brightness profile ────────────────────────────────────────
    // Cylindrical glass: brighter wall columns left/right → high colStdDev.
    // Flat opaque surface (phone, book): near-identical columns → low colStdDev.
    var colSums = [Float](repeating: 0, count: sampleW)
    for (i, s) in samples.enumerated() { colSums[i % sampleW] += s.lightness }
    let colMeans = colSums.map { $0 / Float(sampleH) }
    let colAvg   = colMeans.reduce(0, +) / Float(sampleW)
    var colVarSum: Float = 0
    for cm in colMeans { let d = cm - colAvg; colVarSum += d * d }
    let colStdDev = (colVarSum / Float(sampleW)).squareRoot()

    // ── Edge vs centre brightness (horizontal specular profile) ─────────────
    // Glass walls refract and reflect light → left/right edge columns are
    // brighter than the interior centre.
    let edgeCols = 4   // outer 4 columns each side (of 20 total)
    var edgeSum: Float = 0;   var edgeCount   = 0
    var centreSum: Float = 0; var centreCount = 0
    for (i, s) in samples.enumerated() {
      let col = i % sampleW
      if col < edgeCols || col >= sampleW - edgeCols {
        edgeSum   += s.lightness; edgeCount   += 1
      } else if col >= sampleW / 3 && col < 2 * sampleW / 3 {
        centreSum += s.lightness; centreCount += 1
      }
    }
    let edgeMean   = edgeCount   > 0 ? edgeSum   / Float(edgeCount)   : meanL
    let centreMean = centreCount > 0 ? centreSum / Float(centreCount) : meanL
    let edgeDelta  = edgeMean - centreMean

    // ── Vertical gradient ────────────────────────────────────────────────────
    // A water glass has a non-uniform vertical brightness distribution:
    //   • Top rim     — bright specular highlight
    //   • Water body  — slightly dimmer / translucent
    //   • Bottom base — bright table reflection
    // Flat objects (phones, opaque mugs) show near-zero vertical variation.
    //
    // Divide the 40 rows into thirds, compute per-band mean, take max−min.
    let rowsPerBand = sampleH / 3
    var bandSums = [Float](repeating: 0, count: 3)
    for (i, s) in samples.enumerated() {
      let band = min(i / sampleW / rowsPerBand, 2)
      bandSums[band] += s.lightness
    }
    let pixPerBand = Float(rowsPerBand * sampleW)
    let bandMeans  = bandSums.map { $0 / pixPerBand }
    let vertRange  = bandMeans.max()! - bandMeans.min()!

    // ── Background consistency ────────────────────────────────────────────────
    // Transparent glass lets background show through → inside ≈ surrounding ring.
    // Opaque object → inside is optically distinct from its surroundings.
    // bgScore = 1 − bgDiff/0.18. bgScore reaches 0 at bgDiff = 0.18, which
    // collapses the multiplicative product — no separate hard gate needed.
    let padX = Float(normRect.width)  * 0.25
    let padY = Float(normRect.height) * 0.15

    let exMinX = max(0.0, Float(normRect.minX) - padX)
    let exMinY = max(0.0, Float(normRect.minY) - padY)
    let exMaxX = min(1.0, Float(normRect.maxX) + padX)
    let exMaxY = min(1.0, Float(normRect.maxY) + padY)

    let outerRect = CGRect(
      x: CGFloat(exMinX), y: CGFloat(exMinY),
      width:  CGFloat(exMaxX - exMinX),
      height: CGFloat(exMaxY - exMinY)
    )

    let outerW = 26, outerH = 50
    let outerSamples = sampleRegion(
      cgImage: cgImage, normRect: outerRect,
      sampleW: outerW, sampleH: outerH
    )

    var bgDiff:  Float = 0.0
    var bgScore: Float = 1.0   // neutral when outer region is unavailable

    if outerSamples.count >= 60 {
      var outerSum: Float = 0
      for s in outerSamples { outerSum += s.lightness }
      let outerMean = outerSum / Float(outerSamples.count)

      let innerArea = Float(normRect.width  * normRect.height)
      let outerArea = Float(outerRect.width * outerRect.height)
      let ringArea  = outerArea - innerArea

      if ringArea > 0.0001 {
        let ringMean = (outerMean * outerArea - meanL * innerArea) / ringArea
        bgDiff  = abs(meanL - ringMean)
        bgScore = max(0, min(1, 1.0 - bgDiff / 0.18))
      }
    }

    // ── Individual scores, clamped to [0, 1] ────────────────────────────────

    // satScore: normalisation range widened from 0.30 → 0.50.
    //
    // Root cause of over-rejection: with range 0.30, any meanS ≥ 0.30 produces
    // satScore = 0, which destroys the multiplicative product even when every other
    // signal is strong.  In the observed logs, S = 0.307 (barely over 0.30) gave
    // satScore = 0 while var/col/edge were all 1.00.
    //
    // With range 0.50: S = 0.307 → satScore = 0.39 (meaningful); S = 0.50 → 0.0.
    // Objects with S > 0.50 are still fully suppressed via satScore alone.
    let satScore    = max(0, min(1, 1.0 - meanS / 0.50))

    // brightScore: logged only, not in the product.
    // The dark soft-gate penalty (below) handles low-lightness rejection.
    let brightScore = max(0, min(1, (meanL - 0.20) / 0.40))

    // varScore: 1.0 when stdDevL ≥ 0.10 (background clearly visible through glass).
    let varScore    = max(0, min(1, stdDevL / 0.10))

    // edgeScore: 1.0 when edgeDelta ≥ 0.07 (specular highlights on glass walls).
    let edgeScore   = max(0, min(1, (edgeDelta + 0.03) / 0.10))

    // colScore: 1.0 when colStdDev ≥ 0.04 (curved column brightness profile).
    let colScore    = max(0, min(1, colStdDev / 0.04))

    // vGradScore: 1.0 when vertRange ≥ 0.06 (visible top-to-bottom gradient).
    let vGradScore  = max(0, min(1, vertRange / 0.06))

    // ── Full numeric calibration line ────────────────────────────────────────
    // Always emitted so the caller can log it regardless of the outcome.
    let debug =
      "L:\(String(format:"%.3f",meanL))" +
      " S:\(String(format:"%.3f",meanS))" +
      " stdL:\(String(format:"%.3f",stdDevL))" +
      " stdS:\(String(format:"%.3f",stdDevS))" +
      " colStd:\(String(format:"%.3f",colStdDev))" +
      " eΔ:\(String(format:"%.3f",edgeDelta))" +
      " vRange:\(String(format:"%.3f",vertRange))" +
      " bgDiff:\(String(format:"%.3f",bgDiff))"

    // ── Extreme hard gates ───────────────────────────────────────────────────
    // Only four truly impossible-to-be-glass conditions still hard-zero the score.
    // Everything else is handled by soft penalties below.
    //
    //   meanL   < 0.08  — pitch-black region (phone face-down, covered lens)
    //   stdDevL < 0.010 — zero variance means a solid colour patch, never glass
    //   meanS   > 0.55  — deeply saturated; also satScore = 0 handles S > 0.50
    //   stdDevS > 0.25  — saturation swings wilder than any real glass scene

    var hardTag = ""
    if meanL   < 0.08  { hardTag += " [DARK]"    }
    if stdDevL < 0.010 { hardTag += " [UNIFORM]" }
    if meanS   > 0.55  { hardTag += " [COLORED]" }
    if stdDevS > 0.25  { hardTag += " [PATCHY]"  }

    if !hardTag.isEmpty {
      return TransparencyResult(
        isTransparent: false,
        satScore: satScore, brightScore: brightScore,
        varScore: varScore, edgeScore: edgeScore,
        colScore: colScore, vGradScore: vGradScore,
        bgScore: bgScore, bgDiff: bgDiff,
        combined: 0,
        rejectionTag: hardTag.trimmingCharacters(in: .whitespaces),
        debug: debug
      )
    }

    // ── Soft-gate penalty multipliers ─────────────────────────────────────────
    //
    // Each penalty is in [minPenalty, 1.0]:
    //   1.0          — signal is healthy, no reduction applied
    //   minPenalty   — signal is at the extreme edge of its soft zone
    //
    // The five penalties are multiplied into penaltyMul, so:
    //   • One borderline condition  → moderate product reduction
    //   • Two borderline conditions → compound reduction (more severe)
    //   • Five borderline conditions at minimum → 0.40^5 ≈ 0.010 (effectively zero)
    //
    // This replaces five of the seven former hard gates.  The remaining two
    // (bgDiff and meanS) are handled by bgScore (continuous) and satScore (continuous)
    // already embedded in the multiplicative product.
    //
    // Soft-zone formula:  t = clamp((threshold − value) / (threshold − extreme), 0, 1)
    //                     penalty = 1.0 − (1.0 − minPenalty) × t

    var penaltyMul: Float = 1.0
    var softTags: [String] = []

    // DARK soft gate — glass may appear dim in low-light or mixed-ambient scenes.
    // Zone: meanL ∈ [0.08, 0.22].  At 0.22 no penalty; at 0.08 penalty = 0.40.
    if meanL < 0.22 {
      let t = min(1, (0.22 - meanL) / (0.22 - 0.08))
      let p = max(0.40, 1.0 - 0.60 * t)
      penaltyMul *= p
      softTags.append(String(format: "[DARK×%.2f]", p))
    }

    // UNIFORM soft gate — slightly low stdDevL allowed (overcast / diffuse light).
    // Zone: stdDevL ∈ [0.010, 0.055].  At 0.055 no penalty; at 0.010 penalty = 0.40.
    if stdDevL < 0.055 {
      let t = min(1, (0.055 - stdDevL) / (0.055 - 0.010))
      let p = max(0.40, 1.0 - 0.60 * t)
      penaltyMul *= p
      softTags.append(String(format: "[UNIFORM×%.2f]", p))
    }

    // PATCHY soft gate — glass may hold lightly tinted liquid or show condensation.
    // Zone: stdDevS ∈ [0.11, 0.25].  At 0.11 no penalty; at 0.25 penalty = 0.45.
    if stdDevS > 0.11 {
      let t = min(1, (stdDevS - 0.11) / (0.25 - 0.11))
      let p = max(0.45, 1.0 - 0.55 * t)
      penaltyMul *= p
      softTags.append(String(format: "[PATCHY×%.2f]", p))
    }

    // FLAT_COL soft gate — cylindrical profile varies by glass shape; some tumblers
    // are nearly flat-sided.
    // Zone: colStdDev ∈ [0.005, 0.030].  At 0.030 no penalty; at 0.005 penalty = 0.40.
    if colStdDev < 0.030 {
      let t = min(1, (0.030 - colStdDev) / (0.030 - 0.005))
      let p = max(0.40, 1.0 - 0.60 * t)
      penaltyMul *= p
      softTags.append(String(format: "[FLAT_C×%.2f]", p))
    }

    // FLAT_VERT soft gate — a full glass or uniform background may suppress the
    // vertical gradient.
    // Zone: vertRange ∈ [0.003, 0.018].  At 0.018 no penalty; at 0.003 penalty = 0.45.
    if vertRange < 0.018 {
      let t = min(1, (0.018 - vertRange) / (0.018 - 0.003))
      let p = max(0.45, 1.0 - 0.55 * t)
      penaltyMul *= p
      softTags.append(String(format: "[FLAT_V×%.2f]", p))
    }

    let rejTag = softTags.joined(separator: " ")

    // ── Multiplicative combined score with penalty ────────────────────────────
    //
    // combined = satScore × varScore × colScore × edgeScore × vGradScore
    //          × bgScore × penaltyMul
    //
    // bgScore already encodes the background-opacity penalty (reaches 0 at
    // bgDiff = 0.18) so no separate [BG_OPAQUE] hard gate is needed.
    //
    // brightScore is excluded from the product — the DARK soft gate applies the
    // same physical information as a continuous penalty rather than double-penalising
    // via both a hard gate and a score factor.
    //
    // Threshold guidance (passed in from caller as `threshold`):
    //   All factors at 0.75 → 0.75^6 × 1.0 ≈ 0.178  (well above 0.08)
    //   One factor at 0.35, others at 0.80 → 0.35 × 0.80^5 × 0.72 ≈ 0.082 (passes)
    //   Two factors at 0.30/0.40, others at 0.80 → 0.30 × 0.40 × 0.80^4 × 0.64 ≈ 0.031 (fails)
    let combined =
        satScore
      * varScore
      * colScore
      * edgeScore
      * vGradScore
      * bgScore
      * penaltyMul

    return TransparencyResult(
      isTransparent: combined >= threshold,
      satScore: satScore, brightScore: brightScore,
      varScore: varScore, edgeScore: edgeScore,
      colScore: colScore, vGradScore: vGradScore,
      bgScore: bgScore, bgDiff: bgDiff,
      combined: combined,
      rejectionTag: rejTag,
      debug: debug
    )
  }

  // MARK: – Pixel sampler

  /// Crops normRect from cgImage (Vision normalised coordinates) and resamples
  /// it to sampleW × sampleH pixels via a CGContext.
  ///
  /// CGContext rendering is format-safe: it handles HEIF, YUV, wide-gamut, and
  /// any other internal CGImage encoding by always producing RGBA8 output.
  ///
  /// Coordinate mapping:
  ///   Vision  — origin bottom-left, y upward
  ///   CGImage — origin top-left,    y downward
  ///   → pixY (from top) = imgH × (1 − normRect.maxY)
  private static func sampleRegion(
    cgImage: CGImage,
    normRect: CGRect,
    sampleW: Int,
    sampleH: Int
  ) -> [PixelSample] {

    let imgW = CGFloat(cgImage.width)
    let imgH = CGFloat(cgImage.height)

    let pixX = normRect.minX * imgW
    let pixY = (1.0 - normRect.maxY) * imgH
    let pixW = max(1.0, normRect.width  * imgW)
    let pixH = max(1.0, normRect.height * imgH)

    guard let cropped = cgImage.cropping(
      to: CGRect(x: pixX, y: pixY, width: pixW, height: pixH)
    ) else { return [] }

    let cs = CGColorSpaceCreateDeviceRGB()
    guard let ctx = CGContext(
      data: nil,
      width: sampleW, height: sampleH,
      bitsPerComponent: 8, bytesPerRow: sampleW * 4,
      space: cs,
      bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
    ) else { return [] }

    ctx.draw(cropped, in: CGRect(x: 0, y: 0, width: sampleW, height: sampleH))
    guard let raw = ctx.data else { return [] }

    let ptr = raw.bindMemory(to: UInt8.self, capacity: sampleW * sampleH * 4)
    var result = [PixelSample]()
    result.reserveCapacity(sampleW * sampleH)

    for i in 0..<(sampleW * sampleH) {
      let r = Float(ptr[i * 4 + 0]) / 255.0
      let g = Float(ptr[i * 4 + 1]) / 255.0
      let b = Float(ptr[i * 4 + 2]) / 255.0
      let maxC = max(r, max(g, b))
      let minC = min(r, min(g, b))
      result.append(PixelSample(
        lightness:  (maxC + minC) * 0.5,
        saturation: maxC > 0.001 ? (maxC - minC) / maxC : 0.0
      ))
    }
    return result
  }

  @objc static func requiresMainQueueSetup() -> Bool { false }
}

// MARK: – CGImagePropertyOrientation ↔ UIImage.Orientation

private extension CGImagePropertyOrientation {
  init(_ o: UIImage.Orientation) {
    switch o {
    case .up:            self = .up
    case .upMirrored:    self = .upMirrored
    case .down:          self = .down
    case .downMirrored:  self = .downMirrored
    case .left:          self = .left
    case .leftMirrored:  self = .leftMirrored
    case .right:         self = .right
    case .rightMirrored: self = .rightMirrored
    @unknown default:    self = .up
    }
  }
}
