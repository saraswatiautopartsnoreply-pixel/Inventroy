import { createHash } from 'node:crypto';

const API_ROOT = 'https://api.backblazeb2.com/b2api/v3';
let authorization;
let authorizationExpiresAt = 0;

export const backblazeConfigured = () => Boolean(
  process.env.BACKBLAZE_KEY_ID
  && process.env.BACKBLAZE_APPLICATION_KEY
  && process.env.BACKBLAZE_BUCKET_ID,
);

async function getAuthorization(force = false) {
  if (!backblazeConfigured()) throw new Error('Backblaze B2 storage is not configured on the server.');
  if (!force && authorization && Date.now() < authorizationExpiresAt) return authorization;

  const credentials = Buffer.from(`${process.env.BACKBLAZE_KEY_ID}:${process.env.BACKBLAZE_APPLICATION_KEY}`).toString('base64');
  const response = await fetch(`${API_ROOT}/b2_authorize_account`, {
    headers: { Authorization: `Basic ${credentials}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`Backblaze authorization failed (${response.status}). Check the bucket-restricted app key and its capabilities.`);
  authorization = await response.json();
  authorizationExpiresAt = Date.now() + 20 * 60 * 60 * 1000;
  return authorization;
}

async function apiRequest(path, options = {}, retried = false) {
  const auth = await getAuthorization();
  const response = await fetch(`${auth.apiUrl}/b2api/v4/${path}`, {
    ...options,
    headers: { Authorization: auth.authorizationToken, Accept: 'application/json', ...(options.headers || {}) },
    signal: options.signal || AbortSignal.timeout(30_000),
  });
  if (response.status === 401 && !retried) {
    authorization = null;
    authorizationExpiresAt = 0;
    return apiRequest(path, options, true);
  }
  return { response, auth };
}

export async function uploadBackblazeMedia({ body, contentType, fileName }) {
  const sha1 = createHash('sha1').update(body).digest('hex');
  let lastError;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const { response: urlResponse } = await apiRequest(`b2_get_upload_url?bucketId=${encodeURIComponent(process.env.BACKBLAZE_BUCKET_ID)}`);
      if (!urlResponse.ok) throw new Error(`Backblaze could not prepare an upload (${urlResponse.status}).`);
      const uploadTarget = await urlResponse.json();
      const uploadResponse = await fetch(uploadTarget.uploadUrl, {
        method: 'POST',
        headers: {
          Authorization: uploadTarget.authorizationToken,
          'X-Bz-File-Name': encodeURIComponent(fileName),
          'Content-Type': contentType,
          'X-Bz-Content-Sha1': sha1,
          'X-Bz-Info-Original': 'saraswati-inventory',
        },
        body,
        signal: AbortSignal.timeout(60_000),
      });
      if (uploadResponse.ok) return uploadResponse.json();
      if (uploadResponse.status < 500) throw new Error(`Backblaze rejected the media upload (${uploadResponse.status}).`);
      lastError = new Error(`Backblaze upload server returned ${uploadResponse.status}.`);
    } catch (error) {
      lastError = error;
      if (error?.status && error.status < 500) throw error;
    }
  }
  throw lastError || new Error('Backblaze could not upload the media.');
}

export async function downloadBackblazeMedia(fileId, range = '') {
  const auth = await getAuthorization();
  const url = `${auth.downloadUrl}/b2api/v4/b2_download_file_by_id?fileId=${encodeURIComponent(fileId)}`;
  const response = await fetch(url, {
    headers: { Authorization: auth.authorizationToken, ...(range ? { Range: range } : {}) },
    signal: AbortSignal.timeout(45_000),
  });
  if (!response.ok) throw Object.assign(new Error('Backblaze media could not be downloaded.'), { status: response.status });
  return response;
}

export async function deleteBackblazeMedia(fileId, fileName) {
  if (!fileId || !fileName) return;
  const { response } = await apiRequest('b2_delete_file_version', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fileId, fileName }),
  });
  if (response.ok) return;
  const result = await response.json().catch(() => ({}));
  if (response.status === 404 || result.code === 'file_not_present') return;
  throw new Error(`Backblaze could not delete media (${response.status}).`);
}
