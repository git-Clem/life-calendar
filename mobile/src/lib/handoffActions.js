import { Alert, Linking } from 'react-native';

export function buildMapUrl(provider, destination) {
  const encoded = encodeURIComponent(String(destination || '').trim());
  if (!encoded) return '';

  switch (provider) {
    case 'apple':
      return `https://maps.apple.com/?daddr=${encoded}&dirflg=d`;
    case 'google':
      return `https://www.google.com/maps/dir/?api=1&destination=${encoded}&travelmode=driving`;
    case 'waze':
      return `https://waze.com/ul?q=${encoded}&navigate=yes`;
    default:
      return '';
  }
}

export function isLikelyUrl(value) {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol);
  } catch {
    return false;
  }
}

export async function openExternalUrl(url) {
  if (!url) return;
  await Linking.openURL(url);
}

export function openMapProviderPicker(destination) {
  Alert.alert(
    'Open in Maps',
    'Choose a maps app. The selected provider receives this destination.',
    [
      { text: 'Apple Maps', onPress: () => openExternalUrl(buildMapUrl('apple', destination)) },
      { text: 'Google Maps', onPress: () => openExternalUrl(buildMapUrl('google', destination)) },
      { text: 'Waze', onPress: () => openExternalUrl(buildMapUrl('waze', destination)) },
      { text: 'Cancel', style: 'cancel' },
    ],
  );
}
