"""Convert the supplied original practice set to the application's question schema."""
import json
import re
import sys
from pathlib import Path
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt

root = Path(__file__).resolve().parents[1]
source = Path(sys.argv[1]).read_text()
entries = list(re.finditer(r'\*\*([A-Z][A-Z0-9-]*\d+)\.\*\*', source))
questions = []
mapping = {'RA':'read_aloud','RS':'repeat_sentence','DI':'describe_image','RL':'re_tell_lecture','ASQ':'answer_short_question','SGD':'summarize_group_discussion','RTS':'respond_to_a_situation','SWT':'summarize_written_text','WE':'essay','R-MCSA':'reading_mcq_single','R-MCMA':'reading_mcq_multiple','R-ROP':'reorder_paragraphs','R-FB-D':'reading_fill_blanks','R-FBD':'reading_writing_fill_blanks','L-SST':'summarize_spoken_text','L-MCMA':'listening_mcq_multiple','L-FIT':'listening_fill_blanks','L-HCS':'highlight_correct_summary','L-MCSA':'listening_mcq_single','L-SMW':'select_missing_word','L-HIW':'highlight_incorrect_words','L-WFD':'write_from_dictation'}
instructions = {'RA':'Look at the text below. Read it aloud after the preparation time.','RS':'Listen to the sentence and repeat it exactly as you hear it.','DI':'Look at the image. Describe its main features in detail.','RL':'Listen to the lecture. Retell its main ideas in your own words.','ASQ':'Listen to the question. Answer with one word or a few words.','SGD':'Listen to the discussion. Summarize the views of all three speakers and their proposed next step.','RTS':'Read and listen to the situation. Respond appropriately to the person involved.','SWT':'Summarize the text in one sentence of 5–75 words.','WE':'Write an essay of 200–300 words.','L-SST':'Listen to the recording. Write a summary of 50–70 words.','R-ROP':'Arrange the paragraphs in the correct order.','R-FB-D':'Drag the words into the blanks. Use each word no more than once.','R-FBD':'Select the correct word from each dropdown.','L-FIT':'Listen to the recording. Type the missing words in each blank.','L-HIW':'Listen to the recording. Click every word in the displayed transcript that differs from the recording. Click again to deselect.','L-WFD':'Listen to the sentence. Write it exactly as you hear it.','L-SMW':'Listen to the recording. Select the word that completes the final sentence.'}
def clean(s):
    return s.replace('**','').replace('*','').strip()
def key_of(s):
    m = re.search(r'\*\*Key(?::\*\*|:\s*)(.*?)(?:\*\*|$)', s)
    return clean(m.group(1)).rstrip('.') if m else ''
for i, m in enumerate(entries):
    code = m.group(1)
    body = source[m.end():entries[i+1].start() if i+1<len(entries) else source.index('## Admin Answer Key')].split('\n###')[0].split('\n##')[0].strip()
    prefix = re.sub(r'\d+$','',code)
    subtype = mapping[prefix]
    section = 'reading' if prefix.startswith('R-') else 'listening' if prefix.startswith('L-') else 'writing' if prefix in ['SWT','WE'] else 'speaking'
    q = dict(id='set01-'+code.lower(),type=section,subType=subtype,title='Set 01 · '+code,prompt=instructions.get(prefix,''),textContent='',audioUrl='',imageUrl='',audioScript='',options=[],blankOptions=[],answerKey='',correctAnswer='',correctAnswers=[],incorrectWordIndexes=[],evaluationType='answerKey',time=0,prepareTime=0,recordTime=0)
    italic = re.findall(r'(?<!\*)\*([^*]+)\*(?!\*)', body)
    key = key_of(body)
    if prefix=='RA': q['textContent']=italic[0]
    elif prefix in ['RS','RL','L-SST','L-WFD']: q['audioScript']=italic[0]; q['answerKey']=italic[0]
    elif prefix=='DI': q['answerKey']=clean(body); q['imageUrl']='/uploads/set01-'+code.lower()+'.png'
    elif prefix=='ASQ':
        q['audioScript']=body.split('Answers are in the key.')[0].strip()
        q['answerKey']={'ASQ1':'thermometer','ASQ2':'geologist','ASQ3':'heart','ASQ4':'reference list / bibliography','ASQ5':'contract / shrink'}[code]
    elif prefix=='SGD': q['audioScript']=clean(body); q['answerKey']=clean(body)
    elif prefix=='RTS': q['textContent']=clean(body); q['audioScript']=clean(body); q['answerKey']=clean(body)
    elif prefix in ['SWT','WE']: q['textContent']=italic[0]; q['answerKey']=italic[0]
    elif prefix in ['R-MCSA','R-MCMA','L-MCMA','L-HCS','L-MCSA','L-SMW']:
        option_start = body.index('A)')
        opt_text=body[option_start:].split('**Key:')[0]
        options=[clean(x).rstrip('.') for x in re.findall(r'[A-D]\)\s*(.*?)(?=\s+[A-D]\)|$)',opt_text)]
        q['options']=options
        correct=[options[ord(x)-ord('A')] for x in re.findall(r'[A-D]',key)]
        if prefix.endswith('MCMA'): q['correctAnswers']=correct; q['evaluationType']='correctAnswers'
        else: q['correctAnswer']=correct[0]; q['evaluationType']='correctAnswer'
        if section=='reading':
            q['textContent']=italic[0]
            stem=clean(body.split('*'+italic[0]+'*',1)[1][:]).split('A)')[0].strip()
        else:
            q['audioScript']=italic[0]
            stem=clean(body.split('*'+italic[0]+'*',1)[1]).split('A)')[0].replace('Options:','').strip()
        q['prompt']=(('Read the text. ' if section=='reading' else 'Listen to the recording. ') + ('Select two answers. ' if prefix.endswith('MCMA') else 'Select one answer. ') + stem).strip()
        if prefix=='L-SMW': q['prompt']=instructions[prefix]
    elif prefix=='R-ROP':
        p=body.split('**Key:')[0].split('Put in logical order:',1)[1]
        q['textContent']='\n'.join(clean(x) for x in re.findall(r'[A-D]\)\s*(.*?)(?=\s+[A-D]\)|$)',p))
        q['answerKey']=','.join(str(ord(x)-ord('A')+1) for x in re.findall('[A-D]',key))
    elif prefix=='R-FB-D':
        q['textContent']=italic[0].replace('___','_______')
        q['options']=[x.strip() for x in body.split('Options:',1)[1].split('**Key:')[0].strip().rstrip('.').split('/')]
        q['correctAnswers']=[x.strip() for x in key.split(';')]; q['evaluationType']='correctAnswers'
    elif prefix=='R-FBD':
        sentence=italic[0]
        q['blankOptions']=[[x.strip() for x in choice.split('/')] for choice in re.findall(r'___\s*\(([^)]+)\)',sentence)]
        q['textContent']=re.sub(r'___\s*\([^)]+\)','_______',sentence)
        q['options']=list(dict.fromkeys(x for choices in q['blankOptions'] for x in choices))
        q['correctAnswers']=[x.strip() for x in key.split(',')]; q['evaluationType']='correctAnswers'
    elif prefix=='L-FIT':
        q['audioScript']=italic[0]
        q['textContent']=clean(body.split('Transcript with blanks:',1)[1].split('**Key:')[0]).replace('___','_______')
        q['correctAnswers']=[x.strip() for x in key.split(';')]; q['evaluationType']='correctAnswers'
    elif prefix=='L-HIW':
        q['audioScript']=italic[0]
        q['textContent']=clean(body.split('Displayed text:',1)[1].split('Click the words')[0])
        answers=[x.strip() for x in key.split(';')]
        q['incorrectWordIndexes']=[i for i,word in enumerate(q['textContent'].split()) if word.strip('.,') in answers]
        q['correctAnswers']=[str(x) for x in q['incorrectWordIndexes']]; q['evaluationType']='correctAnswers'
    questions.append(q)

# Two small wording errors in the source would make its answer keys ambiguous.
next(q for q in questions if q['id']=='set01-r-fb-d1')['textContent']=next(q for q in questions if q['id']=='set01-r-fb-d1')['textContent'].replace('A clear evaluation','Clear evaluation').replace('should be agreed','should be agreed')
next(q for q in questions if q['id']=='set01-r-fbd5')['textContent']=next(q for q in questions if q['id']=='set01-r-fbd5')['textContent'].replace('whom it','who it')
next(q for q in questions if q['id']=='set01-r-fbd5')['blankOptions'][-1]=['addressing','address','was addressed to']
q=next(q for q in questions if q['id']=='set01-r-fbd5'); q['options']=list(dict.fromkeys(x for row in q['blankOptions'] for x in row))
assert len(questions)==66
assert len({q['id'] for q in questions})==66
for q in questions:
    if q['correctAnswers'] and 'fill_blanks' in q['subType']: assert q['textContent'].count('_______')==len(q['correctAnswers']),q['id']
    if q['blankOptions']: assert all(a in opts for a,opts in zip(q['correctAnswers'],q['blankOptions']))
dest=root/'server/seeds/set01.json'; dest.parent.mkdir(exist_ok=True)
dest.write_text(json.dumps(questions,ensure_ascii=False,indent=2)+'\n')

uploads=root/'server/uploads'
plt.rcParams.update({'font.size':13,'axes.spines.top':False,'axes.spines.right':False})
for n in range(1,6):
    fig,ax=plt.subplots(figsize=(8,5),layout='constrained')
    if n==1:
        ax.plot([2010,2015,2020,2025],[18,31,44,57],marker='o',color='#007f89',linewidth=3)
        ax.set(xticks=[2010,2015,2020,2025],ylim=(0,65),ylabel='Share (%)',xlabel='Year',title='Renewable electricity share')
        for x,y in zip([2010,2015,2020,2025],[18,31,44,57]): ax.annotate(str(y)+'%',(x,y),xytext=(0,10),textcoords='offset points',ha='center')
    elif n==2:
        cats=['Lectures','Independent study','Group work']; xs=[0,1,2]
        ax.bar([x-.18 for x in xs],[8,12,4],.36,label='Group A',color='#007f89'); ax.bar([x+.18 for x in xs],[6,15,7],.36,label='Group B',color='#dfa445')
        ax.set(xticks=xs,xticklabels=cats,ylabel='Hours per week',title='Weekly study hours',ylim=(0,18)); ax.legend()
        for c in ax.containers: ax.bar_label(c)
    elif n==3: ax.pie([35,25,20,10,10],labels=['Food','Paper','Plastic','Glass','Other'],autopct='%1.0f%%',colors=['#007f89','#70adb4','#dfa445','#99bca1','#d8dce1']); ax.set_title('Household waste')
    elif n==4:
        ax.axis('off'); ax.set_title('Rainwater collection and reuse')
        labels=['Roof collection','Filter','Storage tank','Pump','Gardens and toilets']
        for i,label in enumerate(labels):
            y=.88-i*.19; ax.text(.5,y,label,ha='center',va='center',bbox={'boxstyle':'round,pad=.5','facecolor':'#e4f2f3','edgecolor':'#007f89'},transform=ax.transAxes)
            if i<4: ax.annotate('',xy=(.5,y-.14),xytext=(.5,y-.05),arrowprops={'arrowstyle':'->','color':'#007f89','lw':2},xycoords='axes fraction')
    else:
        ax.axis('off'); ax.set_title('Average commute time (minutes)')
        t=ax.table(cellText=[['City X','32','46','24'],['City Y','28','39','21']],colLabels=['City','Car','Bus','Bicycle'],cellLoc='center',loc='center'); t.scale(1,3); t.auto_set_font_size(False); t.set_fontsize(15)
    fig.savefig(uploads/f'set01-di{n}.png',dpi=140); plt.close(fig)
print(json.dumps({'questions':len(questions),'sections':{s:sum(q['type']==s for q in questions) for s in ['speaking','writing','reading','listening']},'audio_pending':sum(bool(q['audioScript']) for q in questions)},ensure_ascii=False))
