const test=require('node:test');
const assert=require('node:assert/strict');
const {nextTitle}=require('../client/question-naming');

test('titles use section, task abbreviation and a number',()=>{
  assert.equal(nextTitle([],'speaking','read_aloud'),'S-RA1');
  assert.equal(nextTitle([],'writing','essay'),'W-WE1');
  assert.equal(nextTitle([],'reading','reading_mcq_multiple'),'R-MCMA1');
  assert.equal(nextTitle([],'listening','write_from_dictation'),'L-WFD1');
});
test('existing legacy titles reserve numbers without being changed',()=>{
  const bank=[{type:'listening',subType:'write_from_dictation',title:'Set 01 · L-WFD3'},
    {type:'listening',subType:'write_from_dictation',title:'Custom question'},
    {type:'reading',subType:'reading_mcq_single',title:'R-MCSA99'}];
  const before=JSON.stringify(bank);
  assert.equal(nextTitle(bank,'listening','write_from_dictation'),'L-WFD4');
  assert.equal(nextTitle(bank,'speaking','read_aloud'),'S-RA1');
  assert.equal(JSON.stringify(bank),before);
});
test('saving successive questions advances only the selected task',()=>{
  const bank=[];
  for(let i=1;i<=3;i++){
    const title=nextTitle(bank,'speaking','repeat_sentence');
    assert.equal(title,'S-RS'+i);
    bank.push({type:'speaking',subType:'repeat_sentence',title});
  }
  assert.equal(nextTitle(bank,'speaking','describe_image'),'S-DI1');
});
