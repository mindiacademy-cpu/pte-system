const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(__dirname + '/server.js', 'utf8');
const scoring = source.slice(source.indexOf('function normalizeText('), source.indexOf('function ensureFile('));
const selection = source.slice(source.indexOf('const FULL_EXAM_COUNTS'), source.indexOf('app.post("/create-exam"'));
const context = vm.createContext({console});
vm.runInContext(scoring + selection, context);
vm.runInContext(source.slice(source.indexOf('function getAutomaticPoints('),source.indexOf('function normalizeExamResult(')),context);
const run = text => vm.runInContext(text, context);

test('65-item blueprint and strict shortage detection', () => {
  assert.equal(run('Object.values(FULL_EXAM_COUNTS).reduce((a,b)=>a+b,0)'), 65);
  assert.equal(run('selectFullExam([]).shortages.length'), 22);
});

test('no duplicates and no missing recordings in full exam', () => {
  run(`var bank = Object.entries(FULL_EXAM_COUNTS).flatMap(([subType,n]) =>
    Array.from({length:n+1},(_,i)=>({id:subType+i,subType,prompt:'instruction',
      type:subType.includes('listening')?'listening':'speaking',
      textContent:'passage '+i+' _______',audioUrl:'/audio/'+subType+i,
      imageUrl:'/image/'+subType+i,options:['a','b'],correctAnswer:'a',
      correctAnswers:['a'],answerKey:'1,2'})));
    var result = selectFullExam(bank);
  `);
  assert.equal(run('result.questions.length'), 65);
  assert.equal(run('new Set(result.questions.map(q=>q.id)).size'), 65);
  assert.equal(run('isExamReady({type:"listening",prompt:"test",textContent:"test",audioUrl:""})'), false);
  assert.equal(run('selectFullExam(Array(10).fill(bank[0])).questions.length'), 0);
});

test('negative marking and duplicate selections cannot inflate scores', () => {
  assert.equal(run('scoreMultipleChoice(["a","x"],["a","b"],10)'), 0);
  assert.equal(run('scoreMultipleChoice(["a","a"],["a"],10)'), 10);
  assert.equal(run('scoreMultipleChoice(["x"],["a"],10)'), 0);
  assert.equal(run('calculateAutoScore({subType:"highlight_incorrect_words",textContent:"a b c",incorrectWordIndexes:[1],points:10},["1"])'), 10);
  assert.equal(run('scoreDictation("the the","the cat",10)'), 5);
});

test('empty assigned responses receive zero without calling AI', async () => {
  const enrich = source.slice(source.indexOf('async function enrichAnswersWithScores('), source.indexOf('app.get("/",'));
  vm.runInContext(enrich, context);
  const results = await run('enrichAnswersWithScores([{questionId:"1",type:"speaking",answer:""}],[{id:"1",points:25}])');
  assert.equal(results[0].finalScore,0);
  assert.equal(results[0].maxScore,25);
});

test('automatic maxima depend on task and content, not entered weight', () => {
  assert.equal(run('normalizeQuestion({subType:"reading_mcq_single",points:999}).points'),1);
  assert.equal(run('getAutomaticPoints({subType:"listening_fill_blanks",textContent:"a _______ b _______"})'),2);
  assert.equal(run('getAutomaticPoints({subType:"reading_mcq_multiple",correctAnswers:["a","b","a"]})'),2);
  assert.equal(run('getAutomaticPoints({subType:"write_from_dictation",answerKey:"The cat is on the mat."})'),6);
  assert.equal(run('getAutomaticPoints({subType:"reorder_paragraphs",textContent:"a\\nb\\nc\\nd"})'),3);
  assert.equal(run('getAutomaticPoints({subType:"essay"})'),26);
});

test('deadlines include elapsed time after tab suspension', () => {
  const html = fs.readFileSync(__dirname + '/../client/exam.html','utf8');
  const countdown = html.slice(html.indexOf('    function countdownDeadline('),html.indexOf('    function startPartOneTimer('));
  let now = 100000;
  const values = new Map();
  const clock = vm.createContext({Date:{now:()=>now},localStorage:{getItem:k=>values.get(k),setItem:(k,v)=>values.set(k,v)}});
  vm.runInContext(countdown,clock);
  const deadline = vm.runInContext('countdownDeadline("reading",60)',clock);
  now += 45000;
  assert.equal(vm.runInContext(`secondsRemaining(${deadline})`,clock),15);
  assert.equal(vm.runInContext('countdownDeadline("reading",60)',clock),deadline);
  now += 20000;
  assert.equal(vm.runInContext(`secondsRemaining(${deadline})`,clock),0);
});

test('imported set retains all 66 tasks and excludes the 35 missing recordings', () => {
  const seed = JSON.parse(fs.readFileSync(__dirname+'/seeds/set01.json','utf8'));
  assert.equal(seed.length,66);
  assert.equal(new Set(seed.map(q=>q.id)).size,66);
  context.importedSet = seed;
  assert.equal(run('importedSet.map(normalizeQuestion).filter(isExamReady).length'),31);
  for (const q of seed) {
    if (q.blankOptions?.length) {
      assert.equal(q.blankOptions.length,q.correctAnswers.length);
      q.correctAnswers.forEach((answer,i)=>assert.ok(q.blankOptions[i].includes(answer)));
    }
    if (q.incorrectWordIndexes?.length) {
      const words=q.textContent.split(/\s+/);
      assert.deepEqual(q.incorrectWordIndexes.map(i=>words[i]),q.id.endsWith('1')?['five','two']:['open','replacement.']);
    }
    if(q.type==='listening' && !['listening_fill_blanks','highlight_incorrect_words'].includes(q.subType)) assert.equal(q.textContent,'');
  }
});

test('seed installation preserves existing questions and is repeatable', () => {
  const os = require('node:os');
  const path = require('node:path');
  const {installQuestionSeeds}=require('./question-seeds');
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pte-seed-test-'));
  const file=path.join(dir,'questions.json');
  try {
    fs.writeFileSync(file,JSON.stringify([{id:'original',title:'Existing question',prompt:'Keep me'},{id:'admin-edited',title:'Set 01 · RA1',textContent:'Custom text'}]));
    const installed=installQuestionSeeds(file);
    assert.equal(installed.length,67);
    assert.deepEqual(installed[0],{id:'original',title:'Existing question',prompt:'Keep me'});
    assert.equal(installed[1].textContent,'Custom text');
    assert.equal(installed[1].id,'admin-edited');
    assert.deepEqual(installQuestionSeeds(file),installed);
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});

test('legacy form IDs resolve only to their original imported questions', () => {
  const {resolveQuestionIndex}=require('./question-seeds');
  const aliases=require('./seeds/set01-legacy-ids.json');
  const seed=JSON.parse(fs.readFileSync(__dirname+'/seeds/set01.json','utf8'));
  for (const [id,canonical] of Object.entries(aliases)) assert.equal(seed[resolveQuestionIndex(seed,id)].id,canonical);
  assert.equal(resolveQuestionIndex(seed,'unknown'),-1);
  assert.equal(resolveQuestionIndex([],Object.keys(aliases)[0]),-1);
});
