const fs = require('fs');
const {nextTitle, titleNumber} = require('../client/question-naming');

// Keep the counter beside the bank so deleting the highest title cannot reuse it.
function createTitleStore(bankFile, stateFile = bankFile + '.titles.json') {
  let state = fs.existsSync(stateFile)
    ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : {highest: 0};
  const persist = () => {
    fs.writeFileSync(stateFile + '.tmp', JSON.stringify(state, null, 2));
    fs.renameSync(stateFile + '.tmp', stateFile);
  };
  function next(bank) { return nextTitle(bank, state.highest); }
  function reserve(bank) {
    const title = next(bank);
    state.highest = titleNumber(title);
    persist();
    return title;
  }
  function migrate() {
    const bank = JSON.parse(fs.readFileSync(bankFile, 'utf8'));
    state.highest = Math.max(titleNumber(state.highest), ...bank.map(q => titleNumber(q.title)));
    const seen = new Set();
    let changed = false;
    for (const question of bank) {
      const number = titleNumber(question.title);
      const title = number && !seen.has(number) ? String(number).padStart(3, '0') : reserve(bank);
      if (question.title !== title) {
        if (!question.previousTitle) question.previousTitle = question.title || '';
        question.title = title;
        changed = true;
      }
      seen.add(titleNumber(title));
    }
    if (changed) {
      const backup = bankFile + '.before-numeric-titles.json';
      if (!fs.existsSync(backup)) fs.copyFileSync(bankFile, backup);
      fs.writeFileSync(bankFile + '.tmp', JSON.stringify(bank, null, 2));
      fs.renameSync(bankFile + '.tmp', bankFile);
    }
    persist();
    return bank;
  }
  return {next, reserve, migrate};
}
module.exports = {createTitleStore};
