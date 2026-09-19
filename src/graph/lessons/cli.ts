import type { ParsedArgs } from '../../cli-util.js';
import { getProjectId,resolveProjectId } from '../../db.js';
import { strictFlags } from '../semantic/cli.js';
import { numericFlag } from '../semantic/http.js';
import { text,integer,uuid,SemanticError } from '../semantic/validation.js';
import { readNodeLessons,readLessonDetail,mutateOperatorAttachment } from './service.js';
export async function lessonCli(args:ParsedArgs):Promise<string>{
  const [group,action,...operands]=args.positional;if(group!=='lessons'||operands.length)throw new SemanticError('Invalid graph lessons command');
  strictFlags(args,action==='show'?['project','node','limit','offset']:action==='detail'?['project','lesson']:['project','node','lesson','attachment','reason']);
  const projectId=args.flags.project===undefined?await getProjectId():await resolveProjectId(text(args.flags.project,100));
  if(action==='show')return JSON.stringify(await readNodeLessons(projectId,uuid(args.flags.node),integer(numericFlag(args.flags.limit),1,30,10),integer(numericFlag(args.flags.offset),0,100000,0)),null,2);
  if(action==='detail'){const lesson=await readLessonDetail(projectId,uuid(args.flags.lesson));if(!lesson)throw new SemanticError('Lesson not found',404);return JSON.stringify(lesson,null,2);}
  if(action!=='attach'&&action!=='detach')throw new SemanticError('Expected show, detail, attach or detach');
  const reason=text(args.flags.reason,1000);
  if(args.flags.attachment!==undefined){
    if(action!=='detach'||args.flags.node!==undefined||args.flags.lesson!==undefined)throw new SemanticError('Use exactly one attachment identity form');
    return JSON.stringify(await mutateOperatorAttachment(projectId,{action,attachment_id:uuid(args.flags.attachment),reason},'cli'),null,2);
  }
  return JSON.stringify(await mutateOperatorAttachment(projectId,{action,node_id:uuid(args.flags.node),lesson_id:uuid(args.flags.lesson),reason},'cli'),null,2);
}
