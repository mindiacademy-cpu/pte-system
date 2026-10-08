(function (root) {
  function titleNumber(value) {
    const text = String(value || '').trim();
    if (!/^\d+$/.test(text)) return 0;
    const number = Number(text);
    return Number.isSafeInteger(number) && number > 0 ? number : 0;
  }
  function nextTitle(bank, highWaterMark = 0) {
    let highest = titleNumber(highWaterMark);
    for (const question of bank || []) highest = Math.max(highest, titleNumber(question.title));
    return String(highest + 1).padStart(3, '0');
  }
  const api = {nextTitle, titleNumber};
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PteQuestionNaming = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
