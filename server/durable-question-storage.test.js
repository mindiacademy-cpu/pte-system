const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {createDurableQuestionStorage} = require('./durable-question-storage');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pte-durable-'));
  t.after(() => fs.rmSync(dir, {recursive:true, force:true}));
  const file = path.join(dir, 'questions.json');
  fs.mkdirSync(path.join(dir, 'uploads'));
  fs.writeFileSync(file, '[]');
  const objects = new Map();
  let failure = null;
  const client = {storage:{
    getBucket: async () => ({data:{},error:null}),
    from: () => ({
      upload: async (key, bytes) => {
        if (failure) return {error:{message:failure}};
        objects.set(key, Buffer.from(bytes));
        return {data:{path:key}};
      },
      download: async key => objects.has(key)
        ? {data:new Blob([objects.get(key)])}
        : {error:{statusCode:400,message:'Object not found'}},
      remove: async keys => {
        keys.forEach(key => objects.delete(key));
        return {data:[]};
      }
    })
  }};
  return {file,dir,objects,client,fail: value => {failure=value;},
    store:createDurableQuestionStorage(client,file)};
}

test('deploy restores authored bank, deleted-number counter and exact latest audio bytes', async t => {
  const f=fixture(t);
  const media=path.join(f.dir,'uploads','same.mp3');
  const bank=[{id:'custom',title:'007',audioUrl:'/uploads/same.mp3',prompt:'Updated'}];
  fs.writeFileSync(f.file+'.titles.json', JSON.stringify({highest:12}));
  fs.writeFileSync(media,'LATEST USER AUDIO');
  await f.store.uploadMedia(media,'audio/mpeg');
  await f.store.save(bank);
  fs.writeFileSync(f.file,'[{"id":"old-seed"}]');
  fs.writeFileSync(media,'OLD REPOSITORY AUDIO');
  assert.equal(await f.store.initialize(),true);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.file)),bank);
  assert.equal(JSON.parse(fs.readFileSync(f.file+'.titles.json')).highest,12);
  await Promise.all([f.store.ensureMediaLocal(bank[0].audioUrl),f.store.ensureMediaLocal(bank[0].audioUrl)]);
  assert.equal(fs.readFileSync(media,'utf8'),'LATEST USER AUDIO');
  assert.equal([...f.objects.keys()].filter(key=>key.startsWith('history/')).length,0);
});

test('replacement deletes old media only after successful save; shared files remain until last reference is removed', async t => {
  const f=fixture(t);
  const oldFile=path.join(f.dir,'uploads','old.mp3');
  fs.writeFileSync(oldFile,'OLD');
  await f.store.uploadMedia(oldFile,'audio/mpeg');
  const bank=[{id:'1',audioUrl:'/uploads/old.mp3'},{id:'2',audioUrl:'/uploads/old.mp3'}];
  await f.store.save(bank);
  bank[0].audioUrl='/uploads/new.mp3';
  await f.store.save(bank);
  assert.equal(f.objects.has('media/old.mp3'),true);
  f.fail('offline');
  await assert.rejects(f.store.save([bank[0]]),/offline/);
  assert.equal(f.objects.has('media/old.mp3'),true);
  assert.equal(fs.existsSync(oldFile),true);
  f.fail(null);
  await f.store.save([bank[0]]);
  assert.equal(f.objects.has('media/old.mp3'),false);
  assert.equal(fs.existsSync(oldFile),false);
  assert.deepEqual(JSON.parse(f.objects.get('questions.json')).bank,[bank[0]]);
});

test('failed durable save rejects and retains previously saved bank', async t => {
  const f=fixture(t);
  await f.store.save([{id:'a'}]);
  const before=f.objects.get('questions.json');
  f.fail('Storage unavailable');
  await assert.rejects(f.store.save([{id:'b'}]),/Storage unavailable/);
  assert.deepEqual(f.objects.get('questions.json'),before);
});

test('only absent first-install snapshot allows local bank; corrupt or unavailable remote fails closed', async t => {
  const f=fixture(t);
  assert.equal(await f.store.initialize(),false);
  f.objects.set('questions.json',Buffer.from('{"version":1,"bank":null}'));
  await assert.rejects(f.store.initialize(),/fallback refused/);
  f.client.storage.getBucket=async()=>({error:{statusCode:403,message:'Permission denied'}});
  await assert.rejects(f.store.initialize(),/Permission denied/);
});

test('missing media returns false and cannot escape upload directory', async t => {
  const f=fixture(t);
  assert.equal(await f.store.ensureMediaLocal('/uploads/missing.mp3'),false);
  assert.equal(await f.store.ensureMediaLocal('/uploads/../questions.json'),false);
  assert.equal(await f.store.ensureMediaLocal('/uploads/..'),false);
});

test('seed install retains admin audio and image URLs even when files are missing', t => {
  const f=fixture(t);
  const seeds=require('./seeds/set01.json');
  const edited=seeds.map(q=>({...q,audioUrl:'/uploads/custom-'+q.id+'.mp3',imageUrl:'/uploads/custom-'+q.id+'.png'}));
  fs.writeFileSync(f.file,JSON.stringify(edited));
  const result=require('./question-seeds').installQuestionSeeds(f.file);
  edited.forEach((q,i)=>{
    assert.equal(result[i].audioUrl,q.audioUrl);
    assert.equal(result[i].imageUrl,q.imageUrl);
  });
});
