import {appBase, appPath} from './app-base.js';

const sectionPaths={dashboard:'/dashboard',deals:'/deals',tasks:'/tasks',contacts:'/contacts',companies:'/companies',all:'/lists/all',files:'/files',analytics:'/analytics',settings:'/settings',inbox:'/inbox','pipeline-settings':'/pipelines/settings'};

export const pathForView=view=>appPath(sectionPaths[view]||'/deals');
export const pathForDeal=id=>appPath(`/deals/${Number(id)}`);
export const pathForEntity=(kind,id)=>appPath(`/${kind==='contact'?'contacts':'companies'}/${Number(id)}`);

export function parseRoute(pathname,search=''){
  const path=(appBase && (pathname===appBase || pathname.startsWith(`${appBase}/`)) ? pathname.slice(appBase.length) : pathname).replace(/\/+$/,'')||'/';
  const deal=path.match(/^\/deals\/([1-9]\d*)$/);
  if(deal)return {kind:'deal',id:Number(deal[1])};
  const entity=path.match(/^\/(contacts|companies)\/([1-9]\d*)$/);
  if(entity)return {kind:'entity',entityKind:entity[1]==='contacts'?'contact':'company',id:Number(entity[2])};
  if(path==='/deals/all')return {kind:'allDeals'};
  if(path==='/'||path==='/deals')return {kind:'view',view:'deals',pipelineId:Number(new URLSearchParams(search).get('pipeline'))||null};
  const view=Object.entries(sectionPaths).find(([,value])=>value===path)?.[0];
  return view?{kind:'view',view}:{kind:'unknown'};
}
