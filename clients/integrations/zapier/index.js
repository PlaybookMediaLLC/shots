'use strict';

const { version: platformVersion } = require('zapier-platform-core');
const { request, sets, createDraft } = require('./client');
const { triggers } = require('./hooks');

module.exports = {
  version: require('./package.json').version, platformVersion,
  authentication: {
    type: 'custom',
    fields: [
      {key:'origin',label:'Shots URL',type:'string',required:true,helpText:'Your HTTPS Shots origin, without a path.'},
      {key:'apiKey',label:'Workspace API key',type:'password',required:true,helpText:'Use artifact:read and draft:write. Draft approval and publishing remain human-only.'},
      {key:'workspaceId',label:'Webhook workspace ID',type:'string',required:false,helpText:'For instant triggers, use the workspaceId from the Shots test delivery.'},
      {key:'webhookSecret',label:'Webhook signing secret',type:'password',required:false,helpText:'For instant triggers, copy the secret shown when the owner creates this subscription.'},
    ],
    test: async (z,bundle) => ({id:bundle.authData.origin,sets:(await sets(z,bundle)).length}),
    connectionLabel: '{{origin}}',
  },
  triggers: {
    ...triggers(),
    social_sets:{key:'social_sets',noun:'Profile',display:{label:'List Profiles',description:'Lists the profiles this key can use.',hidden:true},operation:{perform:sets,sample:{id:'brand-example',name:'Example brand'}}},
  },
  creates: {
    create_draft:{key:'create_draft',noun:'Draft',display:{label:'Create Draft',description:'Creates editable content for human review. Retries reuse the source event ID.'},operation:{perform:createDraft,inputFields:[
      {key:'requestId',label:'Source event ID',required:true,type:'string',helpText:'A stable ID for this source event/version. Reuse it after a timeout. A changed payload with the same ID is refused.'},
      {key:'socialSetId',label:'Profile',required:true,type:'string',dynamic:'social_sets.id.name'},
      {key:'text',label:'Draft text',required:true,type:'text',helpText:'Separate thread posts with --- on its own line.'},
      {key:'title',label:'Internal title',type:'string'},
      {key:'platforms',label:'Platforms',type:'string',list:true,helpText:'Optional platform identifiers. Empty uses the profile defaults.'},
    ],sample:{id:'draft-example',title:'Example draft',plainText:'Ready for review',version:1,status:'draft'}}},
    plan_draft:{key:'plan_draft',noun:'Draft',display:{label:'Plan Draft',description:'Adds a tentative calendar time. Does not schedule or publish the draft.'},operation:{perform:(z,bundle) => request(z,bundle,`/api/v1/content-drafts/${encodeURIComponent(bundle.inputData.id)}/plan`,'POST',{plannedFor:bundle.inputData.plannedFor,timeZone:bundle.inputData.timeZone}),inputFields:[{key:'id',label:'Draft ID',type:'string',required:true},{key:'plannedFor',label:'Tentative time',type:'datetime',required:true},{key:'timeZone',label:'IANA time zone',type:'string',required:true}],sample:{id:'draft-example',status:'draft',plannedFor:'2026-11-01T12:00:00Z'}}},
  },
  searches: {
    find_draft:{key:'find_draft',noun:'Draft',display:{label:'Find Draft',description:'Reads a draft by its exact ID.'},operation:{perform:async (z,bundle) => [await request(z,bundle,`/api/v1/content-drafts/${encodeURIComponent(bundle.inputData.id)}`)],inputFields:[{key:'id',label:'Draft ID',type:'string',required:true}],sample:{id:'draft-example',title:'Example draft'}}},
  },
};
