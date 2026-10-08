const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {nextTitle} = require('../client/question-naming');
const {createTitleStore} = require('./question-title-store');

function fixture(t, bank) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pte-titles-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const file = path.join(dir, 'questions.json');
  fs.writeFileSync(file, JSON.stringify(bank));
  return {file, save: bank => fs.writeFileSync(file, JSON.stringify(bank))};
}

test('one global sequence across sections, with at least three digits', () => {
  assert.equal(nextTitle([]), '001');
  assert.equal(nextTitle([{title:'001',type:'speaking'}, {title:'002',type:'listening'}]), '003');
  assert.equal(nextTitle([{title:'999'}]), '1000');
});

test('migration preserves IDs, content and media, retains old names and is repeatable', t => {
  const old = [{id:'abc',title:'S-RS-1',audioUrl:'/uploads/a.mp3',prompt:'Repeat'},
    {id:'def',title:'L-WFD-1',answerKey:'Hello world'}];
  const {file} = fixture(t, old);
  const store = createTitleStore(file);
  const bank = store.migrate();
  assert.deepEqual(bank.map(q=>q.title), ['001','002']);
  bank.forEach((q,i) => {
    assert.deepEqual({...q,title:q.previousTitle,previousTitle:undefined}, {...old[i],previousTitle:undefined});
  });
  assert.deepEqual(store.migrate(), bank);
  assert.deepEqual(JSON.parse(fs.readFileSync(file+'.before-numeric-titles.json')), old);
});

test('deleted highest number stays reserved after restart and after deleting entire bank', t => {
  const {file,save} = fixture(t, [{id:'a',title:'S-RA-1'}]);
  let store = createTitleStore(file);
  const bank = store.migrate();
  assert.equal(store.reserve(bank), '002');
  save([]);
  store = createTitleStore(file);
  store.migrate();
  assert.equal(store.reserve([]), '003');
  assert.equal(store.reserve([]), '004');
});

test('mixed and duplicate numeric titles become unique without changing valid assigned titles', t => {
  const {file} = fixture(t,[{id:'a',title:'003'},{id:'b',title:'3'},{id:'c',title:'S-RS-1'}]);
  const bank = createTitleStore(file).migrate();
  assert.deepEqual(bank.map(q=>q.title),['003','004','005']);
});
