const fs = require('fs');
const path = require('path');

// Add authored sets without replacing administrator-created questions.
function installQuestionSeeds(bankFile) {
  const bank = JSON.parse(fs.readFileSync(bankFile, 'utf8'));
  const seed = JSON.parse(fs.readFileSync(path.join(__dirname, 'seeds/set01.json'), 'utf8'));
  let changed = false;
  for (const question of seed) {
    const existing = bank.find(q => q.id === question.id || q.title === question.title || q.previousTitle === question.title);
    if (!existing) { bank.push(question); changed = true; continue; }
    for (const field of ['audioScript', 'blankOptions', 'incorrectWordIndexes']) {
      if ((!existing[field] || Array.isArray(existing[field]) && !existing[field].length) && question[field]?.length) {
        existing[field] = question[field]; changed = true;
      }
    }
    // Preserve authored URLs even when the local cache has not been downloaded yet.
    if (question.imageUrl && !existing.imageUrl) {
      existing.imageUrl = question.imageUrl; changed = true;
    }
    if (question.audioUrl && !existing.audioUrl) {
      existing.audioUrl = question.audioUrl; changed = true;
    }
  }
  if (changed) fs.writeFileSync(bankFile, JSON.stringify(bank, null, 2));
  return bank;
}

function resolveQuestionIndex(bank, id) {
  const direct = bank.findIndex(q => String(q.id) === String(id));
  if (direct >= 0) return direct;
  const aliases = require('./seeds/set01-legacy-ids.json');
  const canonical = aliases[String(id)];
  if (!canonical) return -1;
  return bank.findIndex(q => String(q.id) === canonical);
}

module.exports = {installQuestionSeeds,resolveQuestionIndex};
