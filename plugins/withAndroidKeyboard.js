/**
 * Config plugin: force windowSoftInputMode=adjustResize sur Android.
 *
 * Sans ce plugin, Android utilise adjustPan par défaut, qui déplace tout l'écran
 * vers le haut sans redimensionner la vue — le KeyboardAvoidingView ne peut pas
 * fonctionner correctement car le viewport n'est pas réduit.
 *
 * adjustResize : Android redimensionne le viewport quand le clavier s'ouvre,
 * ce qui permet au KeyboardAvoidingView behavior="height" d'agir correctement.
 */
const { withAndroidManifest } = require('@expo/config-plugins');

module.exports = function withAndroidKeyboard(config) {
  return withAndroidManifest(config, (config) => {
    const manifest = config.modResults.manifest;
    const application = manifest.application?.[0];
    if (!application) return config;

    const activities = application.activity ?? [];
    const mainActivity = activities.find(
      (a) => a.$['android:name'] === '.MainActivity',
    );

    if (mainActivity) {
      mainActivity.$['android:windowSoftInputMode'] = 'adjustResize';
    }

    return config;
  });
};
