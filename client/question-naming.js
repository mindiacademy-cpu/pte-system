(function (root) {
  const sections = {speaking:'S',writing:'W',reading:'R',listening:'L'};
  const tasks = {
    read_aloud:'RA',repeat_sentence:'RS',describe_image:'DI',re_tell_lecture:'RTL',
    answer_short_question:'ASQ',summarize_group_discussion:'SGD',respond_to_a_situation:'RTS',
    summarize_written_text:'SWT',essay:'WE',reading_writing_fill_blanks:'RWFIB',
    reading_mcq_multiple:'MCMA',reorder_paragraphs:'RP',reading_fill_blanks:'RFIB',
    reading_mcq_single:'MCSA',summarize_spoken_text:'SST',listening_mcq_multiple:'MCMA',
    listening_fill_blanks:'LFIB',highlight_correct_summary:'HCS',listening_mcq_single:'MCSA',
    select_missing_word:'SMW',highlight_incorrect_words:'HIW',write_from_dictation:'WFD'
  };
  function nextTitle(bank, type, subType) {
    const section = sections[type];
    const task = tasks[subType];
    if (!section || !task) return '';
    const pool = (bank || []).filter(q => q.type === type && q.subType === subType);
    let highest = pool.length;
    for (const question of pool) {
      const match = String(question.title || '').trim().match(/(\d+)$/);
      if (match && Number.isSafeInteger(Number(match[1]))) highest = Math.max(highest,Number(match[1]));
    }
    return section+'-'+task+'-'+(highest+1);
  }
  const api = {nextTitle};
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PteQuestionNaming = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
