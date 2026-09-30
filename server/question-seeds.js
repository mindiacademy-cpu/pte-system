const fs = require('fs');
const path = require('path');

// Add authored sets without replacing administrator-created questions.
function installQuestionSeeds(bankFile) {
  const bank = JSON.parse(fs.readFileSync(bankFile, 'utf8'));
  const seed = JSON.parse(fs.readFileSync(path.join(__dirname, 'seeds/set01.json'), 'utf8'));
  let changed = false;
  for (const question of seed) {
    const existing = bank.find(q => q.id === question.id || q.title === question.title);
    if (!existing) { bank.push(question); changed = true; continue; }
    for (const field of ['audioScript', 'blankOptions', 'incorrectWordIndexes']) {
      if ((!existing[field] || Array.isArray(existing[field]) && !existing[field].length) && question[field]?.length) {
        existing[field] = question[field]; changed = true;
      }
    }
    // Uploaded files on ephemeral hosts may disappear after a deployment.
    if (question.imageUrl && (!existing.imageUrl || !fs.existsSync(path.join(__dirname, existing.imageUrl.replace(/^\//, ''))))) {
      existing.imageUrl = question.imageUrl; changed = true;
    }
  }
  if (changed) fs.writeFileSync(bankFile, JSON.stringify(bank, null, 2));
  return bank;
}

module.exports = {installQuestionSeeds};
