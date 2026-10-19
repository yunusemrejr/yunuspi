import { Type } from 'typebox';
import { contextSlice } from './context-code.mjs';
export function registerContextCodeTools(pi) {
  if(process.env.PI_CONTEXT_TOOLS==='off'||process.env.PI_REASONING_AIDS==='off')return;
  const paths=Type.Array(Type.String(),{minItems:1,maxItems:20,description:'Explicit source files inside current workspace; no recursive scans.'});
  const maxChars=Type.Optional(Type.Integer({minimum:1200,maximum:32000,description:'Entire JSON output budget; default 12000.'}));
  const definitions=[
    {name:'context_slice',description:'Return fresh AST function/class bodies and imports ranked by task identifiers, with hashes and omitted coverage. JS/TS/Python; other languages report unsupported. Does not register read-before-edit coverage.',parameters:Type.Object({task:Type.String({maxLength:8192}),paths,maxChars}),run:contextSlice},
  ];
  for(const definition of definitions) pi.registerTool({name:definition.name,label:definition.name.replaceAll('_',' '),description:definition.description,parameters:definition.parameters,
    async execute(id,params,signal,_update,ctx) {
      try {
        if(process.env.PI_CONTEXT_TOOLS==='off'||process.env.PI_REASONING_AIDS==='off')throw new Error('Context tools disabled');
        const result=await definition.run({...params,cwd:ctx.cwd,signal});
        if(signal?.aborted)throw new Error('Cancelled');
        return {content:[{type:'text',text:JSON.stringify(result)}],details:result};
      } catch(error) {return {isError:true,content:[{type:'text',text:`${definition.name}: ${error.message}`}],details:{available:false}};}
    }
  });
}
