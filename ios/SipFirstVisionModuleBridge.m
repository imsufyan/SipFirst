#import <React/RCTBridgeModule.h>

@interface RCT_EXTERN_MODULE(SipFirstVisionModule, NSObject)

RCT_EXTERN_METHOD(analyzeImage:(NSString *)imagePath
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

@end
