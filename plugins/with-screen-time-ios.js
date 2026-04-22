const { withEntitlementsPlist, withInfoPlist } = require("@expo/config-plugins");

function ensureArray(value) {
  return Array.isArray(value) ? value : [];
}

module.exports = function withScreenTimeIOS(config, props = {}) {
  const appGroupIdentifier = props.appGroupIdentifier || "group.com.plentycompany.sipfirst";
  const deepLinkScheme = props.deepLinkScheme || "sipfirst";

  config = withEntitlementsPlist(config, (modConfig) => {
    const currentGroups = ensureArray(modConfig.modResults["com.apple.security.application-groups"]);
    if (!currentGroups.includes(appGroupIdentifier)) {
      currentGroups.push(appGroupIdentifier);
    }

    modConfig.modResults["com.apple.security.application-groups"] = currentGroups;
    modConfig.modResults["com.apple.developer.family-controls"] = true;
    return modConfig;
  });

  config = withInfoPlist(config, (modConfig) => {
    const urlTypes = ensureArray(modConfig.modResults.CFBundleURLTypes);
    const hasScheme = urlTypes.some((item) => ensureArray(item.CFBundleURLSchemes).includes(deepLinkScheme));

    if (!hasScheme) {
      urlTypes.push({
        CFBundleURLName: "sipfirst.deeplink",
        CFBundleURLSchemes: [deepLinkScheme],
      });
    }

    modConfig.modResults.CFBundleURLTypes = urlTypes;
    return modConfig;
  });

  return config;
};
