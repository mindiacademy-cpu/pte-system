const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const source=fs.readFileSync(__dirname+'/server.js','utf8');
const start=source.indexOf('function scaleToPTE(');
const end=source.indexOf('function buildEvaluation(');
assert.ok(start>=0&&end>start);
const ctx=vm.createContext({console});
const weightsStart=source.indexOf('const SKILL_WEIGHTS =');
const weightsEnd=source.indexOf(';',weightsStart)+1;
vm.runInContext(source.slice(weightsStart,weightsEnd)+'\
'+source.slice(start,end),ctx);
const run=expression=>vm.runInContext(expression,ctx);
test('overall and skills stay within the PTE 10-90 reporting range',()=>{
 const answers=[{subType:'read_aloud',type:'speaking',maxScore:15,finalScore:15,aiDetails:{speechDetected:true,transcript:'Hello'}},{subType:'reading_mcq_single',type:'reading',maxScore:1,finalScore:1}];
 const summary=run('buildSummary('+JSON.stringify(answers)+')');
 for(const key of ['overall','speaking','writing','reading','listening'])assert.ok(summary[key]>=10&&summary[key]<=90,key);
});
test('blank or unassessed speaking answers never earn points',()=>{
 const blank=[{subType:'read_aloud',type:'speaking',maxScore:15,finalScore:15,transcript:''}];
 assert.equal(run('buildSummary('+JSON.stringify(blank)+').overall'),10);
 const pending=[{subType:'read_aloud',type:'speaking',maxScore:15,finalScore:15,aiDetails:{speechDetected:true,transcript:'Hello',manualReviewRequired:true}}];
 assert.equal(run('buildSummary('+JSON.stringify(pending)+').overall'),10);
});
test('skipped items stay in denominator and reduce overall score',()=>{
 const answered={subType:'reading_mcq_single',type:'reading',maxScore:1,finalScore:1};
 const skipped={subType:'reading_mcq_single',type:'reading',maxScore:1,finalScore:0};
 assert.equal(run('buildSummary('+JSON.stringify([answered])+').overall'),90);
 assert.equal(run('buildSummary('+JSON.stringify([answered,skipped])+').overall'),50);
});
test('invalid or excessive earned scores cannot inflate results',()=>{
 const over=[{subType:'reading_mcq_single',maxScore:1,finalScore:999}];
 assert.equal(run('buildSummary('+JSON.stringify(over)+').overall'),90);
 const negative=[{subType:'reading_mcq_single',maxScore:1,finalScore:-999}];
 assert.equal(run('buildSummary('+JSON.stringify(negative)+').overall'),10);
});
test('exam saving always reconstitutes all assigned questions',()=>{
 const save=source.slice(source.indexOf('app.post("/save-exam"'),source.indexOf('app.post("/save-exam"')+1800);
 assert.match(save,/assignedExam\.questions\.map\(/);
 assert.match(save,/submitted\.get\(String\(q\.id\)\)/);
 assert.match(save,/enrichAnswersWithScores\(completeAnswers, assignedExam\.questions\)/);
 assert.match(save,/existingResult/);
});
