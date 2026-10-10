// Sincronizzazione gratuita tra dispositivi tramite un Gist privato di GitHub.
// Serve un token GitHub con il solo permesso "gist". Nessun server da gestire.
const API = 'https://api.github.com';
const FILE = 'english-tutor-data.json';

async function gh(token, path, options = {}) {
  const res = await fetch(API + path, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
    },
  });
  if (!res.ok) throw new Error(`GitHub ${res.status}${res.status === 401 ? ' (token non valido)' : ''}`);
  return res.json();
}

// Cerca il Gist già creato da un altro dispositivo.
export async function findGist(token) {
  const gists = await gh(token, '/gists?per_page=100');
  return gists.find((g) => g.files && g.files[FILE])?.id || '';
}

export async function pull(token, id) {
  const gist = await gh(token, `/gists/${id}`);
  const file = gist.files[FILE];
  if (!file) return null;
  const content = file.truncated ? await (await fetch(file.raw_url)).text() : file.content;
  return JSON.parse(content);
}

export async function push(token, id, data) {
  const body = { files: { [FILE]: { content: JSON.stringify(data) } } };
  if (id) {
    await gh(token, `/gists/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
    return id;
  }
  const created = await gh(token, '/gists', {
    method: 'POST',
    body: JSON.stringify({ ...body, description: 'English Tutor – archivio di studio', public: false }),
  });
  return created.id;
}
