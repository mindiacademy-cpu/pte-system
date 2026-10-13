const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

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
    // Never overwrite an administrator's intentional audio/image changes, even
    // when a URL was cleared. Seed media only belongs to newly inserted questions.
    // Existing records are authoritative once the bank has been created.
  }
  if (changed) {
    // Keep the previous question bank intact if the seed update is interrupted.
    const temporary = bankFile + '.' + crypto.randomUUID() + '.tmp';
    try {
      fs.writeFileSync(temporary, JSON.stringify(bank, null, 2), 'utf8');
      fs.renameSync(temporary, bankFile);
    } finally {
      if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true });
    }
  }
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
