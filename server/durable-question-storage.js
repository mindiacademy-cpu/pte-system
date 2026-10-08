const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function createDurableQuestionStorage(supabase, bankFile, bucket = 'pte-question-data') {
  const directory = path.dirname(bankFile);
  const stateFile = bankFile + '.titles.json';
  const storage = () => supabase.storage.from(bucket);
  let previousBank = [];
  let pendingMediaDeletes = new Set();
  let deletedMediaUrls = new Set();
  let cleanupRetry;
  let mutation = Promise.resolve();
  function exclusive(action) {
    const operation = mutation.then(action);
    mutation = operation.catch(() => {});
    return operation;
  }
  const missing = error => ['404', 'NotFound', 'not_found'].includes(String(error?.statusCode || error?.status || error?.code)) || /not found|does not exist/i.test(error?.message || '');
  const check = (result, label) => {
    if (result.error) throw new Error(`${label}: ${result.error.message}`);
    return result.data;
  };
  const encode = value => Buffer.from(JSON.stringify(value, null, 2));
  function mediaPath(url) {
    const match = /^\/uploads\/([^/?#]+)$/.exec(String(url || ''));
    if (!match || match[1] === '.' || match[1] === '..' || /[\\]/.test(match[1])) return null;
    return path.join(directory, 'uploads', match[1]);
  }
  const mediaUrls = bank => new Set(bank.flatMap(q => [q.audioUrl, q.imageUrl]).filter(url => mediaPath(url)));
  async function cleanupMedia() {
    if (!pendingMediaDeletes.size) return;
    try {
      const urls = [...pendingMediaDeletes];
      check(await storage().remove(urls.map(url => 'media/' + path.basename(mediaPath(url)))), 'Old media could not be removed');
      for (const url of urls) {
        fs.rmSync(mediaPath(url), {force: true});
        pendingMediaDeletes.delete(url);
      }
    } catch (error) {
      console.error('Old media cleanup will be retried:', error.message);
      if (!cleanupRetry) {
        cleanupRetry = setTimeout(() => { cleanupRetry = null; exclusive(cleanupMedia); }, 30000);
        cleanupRetry.unref();
      }
    }
  }
  async function save(bank) {
    const state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : {highest: 0};
    const active = mediaUrls(bank);
    const obsolete = new Set([...pendingMediaDeletes, ...mediaUrls(previousBank)]
      .filter(url => !active.has(url)));
    const deleted = new Set([...deletedMediaUrls, ...obsolete].filter(url => !active.has(url)));
    const snapshot = encode({version: 1, savedAt: new Date().toISOString(), bank, titleState: state,
      pendingMediaDeletes: [...obsolete], deletedMediaUrls: [...deleted]});
    check(await storage().upload('questions.json', snapshot,
      {contentType: 'application/json', upsert: true}), 'Question bank could not be saved');
    previousBank = JSON.parse(JSON.stringify(bank));
    pendingMediaDeletes = obsolete;
    deletedMediaUrls = deleted;
    // Never remove the old file before its replacement has been saved successfully.
    await cleanupMedia();
  }
  async function initialize() {
    const found = await supabase.storage.getBucket(bucket);
    if (found.error) {
      if (!missing(found.error) && !/not found|does not exist/i.test(found.error.message || '')) check(found, 'Storage unavailable');
      check(await supabase.storage.createBucket(bucket, {public: false}), 'Private question storage could not be created');
    }
    const downloaded = await storage().download('questions.json');
    if (downloaded.error) {
      if (!missing(downloaded.error) && !/not found|does not exist/i.test(downloaded.error.message || '')) check(downloaded, 'Question bank unavailable');
      return false; // First installation: migrate the existing local bank once.
    }
    const snapshot = JSON.parse(await downloaded.data.text());
    if (snapshot.version !== 1 || !Array.isArray(snapshot.bank)) throw new Error('Invalid durable question bank; local seed fallback refused');
    previousBank = snapshot.bank;
    const active = mediaUrls(snapshot.bank);
    deletedMediaUrls = new Set((snapshot.deletedMediaUrls || []).filter(url => mediaPath(url) && !active.has(url)));
    pendingMediaDeletes = new Set([...(snapshot.pendingMediaDeletes || []), ...deletedMediaUrls]
      .filter(url => mediaPath(url) && !active.has(url)));
    for (const url of deletedMediaUrls) fs.rmSync(mediaPath(url), {force: true});
    fs.writeFileSync(bankFile, JSON.stringify(snapshot.bank, null, 2));
    fs.writeFileSync(stateFile, JSON.stringify(snapshot.titleState || {highest: 0}, null, 2));
    // Repository media can be older than the saved upload, even at the same URL.
    for (const url of new Set(snapshot.bank.flatMap(q => [q.audioUrl, q.imageUrl]))) {
      const local = mediaPath(url);
      if (local && fs.existsSync(local)) fs.unlinkSync(local);
    }
    return true;
  }
  async function uploadMedia(filePath, mime) {
    check(await storage().upload(`media/${path.basename(filePath)}`, fs.readFileSync(filePath),
      {contentType: mime || 'application/octet-stream', upsert: true}), 'Media could not be saved permanently');
  }
  async function ensureMediaLocal(url) {
    if (deletedMediaUrls.has(url)) return false;
    const local = mediaPath(url);
    if (!local) return false;
    if (fs.existsSync(local)) return true;
    const result = await storage().download(`media/${path.basename(local)}`);
    if (result.error && missing(result.error)) return false;
    check(result, 'Media unavailable');
    fs.mkdirSync(path.dirname(local), {recursive: true});
    const bytes = Buffer.from(await result.data.arrayBuffer());
    const temporary = local + '.' + crypto.randomUUID() + '.tmp';
    fs.writeFileSync(temporary, bytes);
    fs.renameSync(temporary, local);
    return true;
  }
  async function preserveExistingMedia(bank) {
    const urls = new Set(bank.flatMap(q => [q.audioUrl, q.imageUrl]).filter(Boolean));
    for (const url of urls) {
      const local = mediaPath(url);
      if (local && fs.existsSync(local)) await uploadMedia(local);
    }
  }
  return {initialize, save: bank => exclusive(() => save(bank)), uploadMedia, ensureMediaLocal, preserveExistingMedia,
    isDeletedMedia: url => deletedMediaUrls.has(url)};
}
module.exports = {createDurableQuestionStorage};
