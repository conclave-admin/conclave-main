import { useCallback, useEffect, useState } from 'react';
import { createMediaDownloads } from '../lib/mediaDownloads';
import useNetworkStatus from './useNetworkStatus';
import { allowsAutomaticDownload, getMediaPreferences, networkSnapshot } from '../lib/mediaPreferences';
import { attachmentAccount, attachmentCacheKey, cacheAttachmentBlob, getAttachmentBlob, getCachedAttachmentBlob } from '../services/attachments.service';

const downloads = createMediaDownloads({ keyFor: attachmentCacheKey, read: getCachedAttachmentBlob,
  fetchFile: getAttachmentBlob, cache: cacheAttachmentBlob });
window.addEventListener('conclave:media-cache-removed', (event) => downloads.invalidate(event.detail?.keys));
window.addEventListener('focus', () => downloads.recheck());
const connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
const enforceNetworkPolicy = () => {
  const prefs = getMediaPreferences(); const network = networkSnapshot(connection);
  downloads.cancelAutomatic((attachment) => !allowsAutomaticDownload(prefs, network, navigator.onLine !== false)
    || !(attachment.mime_type?.startsWith('video/') ? prefs.video : prefs.documents));
};
connection?.addEventListener?.('change', enforceNetworkPolicy);
window.addEventListener('conclave:media-preferences', enforceNetworkPolicy);
window.addEventListener('offline', enforceNetworkPolicy);

window.addEventListener('conclave:session-ended', () => downloads.stop());
window.addEventListener('conclave:outbox-stop', () => downloads.stop());
let activeAccount = attachmentAccount();
window.addEventListener('storage', (event) => {
  if (event.key !== 'accessToken' && event.key !== null) return;
  const account = attachmentAccount();
  if (account !== activeAccount) { downloads.stop(); activeAccount = account; }
});

export default function useAttachmentDownload(attachment) {
  const [state, setState] = useState({ status: 'available', checking: true, progress: 0, blob: null, persisted: false, error: '' });
  const [preferences, setPreferences] = useState(getMediaPreferences);
  const network = useNetworkStatus();
  const [online, setOnline] = useState(navigator.onLine !== false);
  const key = attachmentCacheKey(attachment);
  useEffect(() => {
    activeAccount = attachmentAccount();
    return downloads.subscribe(attachment, setState);
  }, [key, attachment.local_blob]);
  useEffect(() => {
    const connected = () => setOnline(navigator.onLine !== false);
    window.addEventListener('online', connected);
    window.addEventListener('offline', connected);
    return () => { window.removeEventListener('online', connected); window.removeEventListener('offline', connected); };
  }, []);
  useEffect(() => {
    const update = () => setPreferences(getMediaPreferences());
    window.addEventListener('conclave:media-preferences', update);
    return () => window.removeEventListener('conclave:media-preferences', update);
  }, []);
  useEffect(() => {
    if (state.checking || state.status !== 'available' || !attachment.id || attachment.local_blob || !allowsAutomaticDownload(preferences, network, online)) return;
    const type = attachment.mime_type || '';
    // Photos always remain previews until opened. These explicit preferences
    // opt into originals for video and documents, independent of cache policy.
    if ((type.startsWith('video/') && preferences.video) || (!/^(image|video)\//.test(type) && preferences.documents)) downloads.start(attachment, { automatic: true });
  }, [key, state.checking, preferences.video, preferences.documents, preferences.network, preferences.respectSaveData, network.type, network.effectiveType, network.saveData, online]);
  const start = useCallback(() => downloads.start(attachment), [key, attachment.local_blob]);
  const cancel = useCallback(() => downloads.cancel(attachment), [key]);
  return { ...state, start, cancel };
}
