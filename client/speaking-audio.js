(function(root) {
  function encodeMonoWav(samples, sampleRate) {
    const bytes = new ArrayBuffer(44 + samples.length * 2);
    const view = new DataView(bytes);
    const write = (offset,text) => {for(let i=0;i<text.length;i++) view.setUint8(offset+i,text.charCodeAt(i));};
    write(0,'RIFF'); view.setUint32(4,36+samples.length*2,true); write(8,'WAVE');
    write(12,'fmt '); view.setUint32(16,16,true); view.setUint16(20,1,true);
    view.setUint16(22,1,true); view.setUint32(24,sampleRate,true);
    view.setUint32(28,sampleRate*2,true); view.setUint16(32,2,true); view.setUint16(34,16,true);
    write(36,'data'); view.setUint32(40,samples.length*2,true);
    for(let i=0;i<samples.length;i++) {
      const sample = Math.max(-1,Math.min(1,samples[i]));
      view.setInt16(44+i*2,sample<0 ? sample*32768 : sample*32767,true);
    }
    return bytes;
  }

  async function toAssessmentWav(blob) {
    const AudioContextClass = root.AudioContext || root.webkitAudioContext;
    const OfflineContextClass = root.OfflineAudioContext || root.webkitOfflineAudioContext;
    if (!AudioContextClass || !OfflineContextClass) throw new Error('Audio decoding unavailable');
    const context = new AudioContextClass();
    try {
      const decoded = await context.decodeAudioData(await blob.arrayBuffer());
      if (!decoded.duration || decoded.duration > 180) throw new Error('Recording duration invalid');
      const offline = new OfflineContextClass(1,Math.ceil(decoded.duration*16000),16000);
      const source = offline.createBufferSource(); source.buffer=decoded;
      source.connect(offline.destination); source.start();
      const rendered = await offline.startRendering();
      return new Blob([encodeMonoWav(rendered.getChannelData(0),16000)],{type:'audio/wav'});
    } finally {
      await context.close();
    }
  }
  async function prepareAnswers(answers) {
    const prepared = [];
    for (const answer of answers) {
      if (answer.type !== 'speaking' || !answer.speakingAudio || /^data:audio\/(wav|mpeg|mp3);/.test(answer.speakingAudio)) {
        prepared.push(answer); continue;
      }
      try {
        const original = await (await fetch(answer.speakingAudio)).blob();
        const wav = await toAssessmentWav(original);
        const dataUrl = await new Promise((resolve,reject)=>{
          const reader = new FileReader(); reader.onload=()=>resolve(reader.result);
          reader.onerror=()=>reject(reader.error); reader.readAsDataURL(wav);
        });
        prepared.push({...answer,speakingAudio:dataUrl});
      } catch (error) {
        // Keep the recording; unsupported audio is explicitly flagged by the server.
        prepared.push(answer);
      }
    }
    return prepared;
  }
  root.PteSpeakingAudio = {encodeMonoWav,toAssessmentWav,prepareAnswers};
  if(typeof module !== 'undefined') module.exports = root.PteSpeakingAudio;
})(typeof window !== 'undefined' ? window : globalThis);
