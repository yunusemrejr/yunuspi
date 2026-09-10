import {Type} from 'typebox';
import {dependencyPlan,decisionFrontier,coverageSelect} from '../runs/shared/reasoning-aids.ts';
export default function(pi:any) {
  if(process.env.PI_REASONING_AIDS==='off' && process.env.PI_SUBAGENT_CHILD!=='1')return;
  const ID=Type.String({minLength:1,maxLength:64});
  const array=(items:any,maxItems:number,minItems=0)=>Type.Array(items,{maxItems,minItems});
  function register(name:string,description:string,parameters:any,run:(p:any)=>unknown) {
    pi.registerTool({name,label:name.replaceAll('_',' '),description,parameters,
      async execute(_id:any,p:any,signal:any) {
        try {
          if(process.env.PI_REASONING_AIDS==='off')throw Error('Reasoning aids are disabled');
          if(signal?.aborted)throw Error('Cancelled');
          const result=run(p);
          return {content:[{type:'text',text:JSON.stringify(result)}],details:result};
        }catch(e){return {isError:true,content:[{type:'text',text:e instanceof Error?e.message:'Invalid input'}],details:{available:false}};}
      }
    });
  }
  register('dependency_plan','Calculate dependency layers and a cycle witness from known tasks. Use for multi-step ordering; does not run tasks, replace todo state or establish safe parallelism.',Type.Object({tasks:array(Type.Object({id:ID,after:Type.Optional(array(ID,16))},{additionalProperties:false}),64,1)},{additionalProperties:false}),p=>dependencyPlan(p.tasks));
  register('decision_frontier','Prune numerically dominated options without inventing weights. Use for measured cost/latency/quality tradeoffs. Values follow criteria order; unknown data must be gathered first.',Type.Object({criteria:array(Type.Object({id:ID,goal:Type.Union([Type.Literal('min'),Type.Literal('max')])},{additionalProperties:false}),8,1),options:array(Type.Object({id:ID,values:array(Type.Number({minimum:-1e12,maximum:1e12}),8,1)},{additionalProperties:false}),32,1)},{additionalProperties:false}),p=>decisionFrontier(p.criteria,p.options));
  register('coverage_select','Suggest a compact check set covering stated requirements using greedy coverage/cost. No optimality or execution claim. Keep mandatory checks; no need for this on a simple task.',Type.Object({requirements:array(ID,64,1),candidates:array(Type.Object({id:ID,covers:array(ID,64),cost:Type.Optional(Type.Number({minimum:1e-9,maximum:1e9}))},{additionalProperties:false}),64)},{additionalProperties:false}),p=>coverageSelect(p.requirements,p.candidates));
}
