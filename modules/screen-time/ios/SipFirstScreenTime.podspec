require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

Pod::Spec.new do |s|
  s.name           = 'SipFirstScreenTime'
  s.version        = package['version']
  s.summary        = 'Local Expo module for Screen Time integrations.'
  s.description    = 'Bridges FamilyControls, ManagedSettings, and DeviceActivity into the SipFirst app.'
  s.license        = { :type => 'MIT' }
  s.author         = { 'SipFirst' => 'dev@localhost' }
  s.homepage       = 'https://expo.dev'
  s.platforms      = { :ios => '16.0' }
  s.swift_version  = '5.0'
  s.source         = { :path => '.' }
  s.source_files   = '**/*.{swift,h,m,mm}'
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
end
