# Changelog

## [2.41.2](https://github.com/PlaybookMediaLLC/shots/compare/v2.41.1...v2.41.2) (2026-10-29)


### Bug Fixes

* **web:** finish the no-plan audit on top of [#389](https://github.com/PlaybookMediaLLC/shots/issues/389) ([#391](https://github.com/PlaybookMediaLLC/shots/issues/391)) ([a986216](https://github.com/PlaybookMediaLLC/shots/commit/a9862161cc68c6bac6c73fee5faae9e682f024b2))

## [2.41.1](https://github.com/PlaybookMediaLLC/shots/compare/v2.41.0...v2.41.1) (2026-10-29)


### Bug Fixes

* **billing:** move each product's default price before archiving the old one ([#387](https://github.com/PlaybookMediaLLC/shots/issues/387)) ([1dade24](https://github.com/PlaybookMediaLLC/shots/commit/1dade24b3473cc371aa46ade633ec2c925ef8f8e))
* **web:** resolve the 2026-10-29 QA audit's plan, checkout and accessibility findings ([#389](https://github.com/PlaybookMediaLLC/shots/issues/389)) ([75da3f6](https://github.com/PlaybookMediaLLC/shots/commit/75da3f68ebb34fb2b146e936fd9eb6c2f563a7aa))

## [2.41.0](https://github.com/PlaybookMediaLLC/shots/compare/v2.40.0...v2.41.0) (2026-10-29)


### Features

* **billing:** reprice against schedulers, remove the free tier, run AI on Haiku 5.5 ([#378](https://github.com/PlaybookMediaLLC/shots/issues/378)) ([d3737fd](https://github.com/PlaybookMediaLLC/shots/commit/d3737fdcbb54662f211f8bb7f66e7ded7442a1a3))

## [2.40.0](https://github.com/PlaybookMediaLLC/shots/compare/v2.39.2...v2.40.0) (2026-10-28)


### Features

* **github:** qualify production deployments with versioned policies ([#368](https://github.com/PlaybookMediaLLC/shots/issues/368)) ([47c3129](https://github.com/PlaybookMediaLLC/shots/commit/47c31294bb0abe68e1e9cd0712e1471e93be4601))


### Bug Fixes

* **scheduling:** reserve reviewed queue slots and settle every publication ([#364](https://github.com/PlaybookMediaLLC/shots/issues/364)) ([60e5b2d](https://github.com/PlaybookMediaLLC/shots/commit/60e5b2debb87ff96f52af42970ab49c9ad02ac54))


### Performance Improvements

* **ci:** move cache exports off the browser critical path ([#372](https://github.com/PlaybookMediaLLC/shots/issues/372)) ([048d44b](https://github.com/PlaybookMediaLLC/shots/commit/048d44b18c233d1a1d1c84f00f8f032786c1681e))
* **ci:** share production builds across end-to-end shards ([#359](https://github.com/PlaybookMediaLLC/shots/issues/359)) ([c363eaf](https://github.com/PlaybookMediaLLC/shots/commit/c363eaf3f8d4b13be2e8f65c55bf6c4dc9ce4787))
* **collab:** send the local cursor at most every 200ms ([#373](https://github.com/PlaybookMediaLLC/shots/issues/373)) ([5e1ab6d](https://github.com/PlaybookMediaLLC/shots/commit/5e1ab6de8609379aed51a20ed2939f02e032eeb7))

## [2.39.2](https://github.com/PlaybookMediaLLC/shots/compare/v2.39.1...v2.39.2) (2026-10-28)


### Bug Fixes

* **web:** keep tabs in their workspace and make starting, finding and reusing work direct ([#362](https://github.com/PlaybookMediaLLC/shots/issues/362)) ([9cb125e](https://github.com/PlaybookMediaLLC/shots/commit/9cb125e82de67e6575d1bc29099a40910ae4d652))


### Performance Improvements

* **collab:** read the membership once per collaboration authorization ([#361](https://github.com/PlaybookMediaLLC/shots/issues/361)) ([d07d8ca](https://github.com/PlaybookMediaLLC/shots/commit/d07d8ca3b0905113f93a24512351c23418b3bdca))

## [2.39.1](https://github.com/PlaybookMediaLLC/shots/compare/v2.39.0...v2.39.1) (2026-10-28)


### Bug Fixes

* **web:** center icons in the compact sidebar; add a native local stack ([#353](https://github.com/PlaybookMediaLLC/shots/issues/353)) ([0b9cb29](https://github.com/PlaybookMediaLLC/shots/commit/0b9cb299de35b5eab74c8eb487e6072407b90368))
* **write:** load the browser copy before seeding a draft's live document ([#355](https://github.com/PlaybookMediaLLC/shots/issues/355)) ([f3fc199](https://github.com/PlaybookMediaLLC/shots/commit/f3fc199776e4e36c55f640a9c3d76a34e4002ea6))

## [2.39.0](https://github.com/PlaybookMediaLLC/shots/compare/v2.38.1...v2.39.0) (2026-10-28)


### Features

* **settings:** give settings Polar's sidebar, one registry and dashboard tokens ([#336](https://github.com/PlaybookMediaLLC/shots/issues/336)) ([6a98fb9](https://github.com/PlaybookMediaLLC/shots/commit/6a98fb92294c4502174bdddb1f80ca7de4cefc64))
* **shell:** drop the plan card and docs link from the settings sidebar ([#339](https://github.com/PlaybookMediaLLC/shots/issues/339)) ([6c4bd17](https://github.com/PlaybookMediaLLC/shots/commit/6c4bd1769f60a0e297cc6c5929209483328adefe))


### Bug Fixes

* **dev:** start the e2e suite's server from an empty dev cache ([#335](https://github.com/PlaybookMediaLLC/shots/issues/335)) ([3dcb97f](https://github.com/PlaybookMediaLLC/shots/commit/3dcb97f05814079e35045d8f797a76c608020f80))
* **web:** fix the QA walkthroughs, move Publish to shadcn, and speed up draft saves ([#338](https://github.com/PlaybookMediaLLC/shots/issues/338)) ([be0bf27](https://github.com/PlaybookMediaLLC/shots/commit/be0bf279e453122657d0a5c73cc8efa66a62cbab))

## [2.38.1](https://github.com/PlaybookMediaLLC/shots/compare/v2.38.0...v2.38.1) (2026-10-27)


### Bug Fixes

* **ci:** check the web IndexNow key at its new path ([#328](https://github.com/PlaybookMediaLLC/shots/issues/328)) ([df14c02](https://github.com/PlaybookMediaLLC/shots/commit/df14c0211d81a6893db15ef947f575902d28a2ba))

## [2.38.0](https://github.com/PlaybookMediaLLC/shots/compare/v2.37.0...v2.38.0) (2026-10-27)


### Features

* **ui:** rework the signed-in app with Polar's shell and studio galleries ([#321](https://github.com/PlaybookMediaLLC/shots/issues/321)) ([eebd8d2](https://github.com/PlaybookMediaLLC/shots/commit/eebd8d24bc71948ca7f69bd268eb74a38ee7ca27))

## [2.37.0](https://github.com/PlaybookMediaLLC/screenshot-studio/compare/v2.36.4...v2.37.0) (2026-10-25)


### Features

* **scheduling:** implement Plan and Analyze workspaces ([#305](https://github.com/PlaybookMediaLLC/screenshot-studio/issues/305)) ([1e49108](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/1e491089f67ef9cea47d62b18153bdba68d0efac))
* **write:** add media workflows and live preview verification ([#306](https://github.com/PlaybookMediaLLC/screenshot-studio/issues/306)) ([54bc009](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/54bc0094b81c19d8a0716341ba39cfd06fdf3f0a))
* **write:** expand Typefully authoring, publishing and planning workflows ([#309](https://github.com/PlaybookMediaLLC/screenshot-studio/issues/309)) ([25689d6](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/25689d66e83347555ab51d2e3c8683ee683bd981))
* **write:** implement Typefully editor, scheduling, and platform options ([#308](https://github.com/PlaybookMediaLLC/screenshot-studio/issues/308)) ([65e3f42](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/65e3f42fb4c7acba21ed44d676457726cb7fbd02))

## [2.36.4](https://github.com/PlaybookMediaLLC/screenshot-studio/compare/v2.36.3...v2.36.4) (2026-10-23)


### Bug Fixes

* **ui:** polish authenticated layouts and responsive controls ([#300](https://github.com/PlaybookMediaLLC/screenshot-studio/issues/300)) ([dda74d8](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/dda74d8684b2a2e16423d945e1ddba5f0135bca8))

## [2.36.3](https://github.com/PlaybookMediaLLC/screenshot-studio/compare/v2.36.2...v2.36.3) (2026-10-22)


### Bug Fixes

* **ui:** keep the first sidebar toggle from being dropped ([#297](https://github.com/PlaybookMediaLLC/screenshot-studio/issues/297)) ([f5a723a](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/f5a723ae2ad4f1dcfb6f2d41ae3ee528f27940a4))

## [2.36.2](https://github.com/PlaybookMediaLLC/screenshot-studio/compare/v2.36.1...v2.36.2) (2026-10-22)


### Bug Fixes

* **ui:** load Phosphor icons individually and repair browser checks ([#295](https://github.com/PlaybookMediaLLC/screenshot-studio/issues/295)) ([c048c7c](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/c048c7ce294495b0c9e2353a0ddd09df91cbe674))

## [2.36.1](https://github.com/PlaybookMediaLLC/screenshot-studio/compare/v2.36.0...v2.36.1) (2026-10-22)


### Bug Fixes

* **ci:** prevent development server memory restarts ([#293](https://github.com/PlaybookMediaLLC/screenshot-studio/issues/293)) ([431d93f](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/431d93fc289eceaa7af9bd54c5331be409e86d05))

## [2.36.0](https://github.com/PlaybookMediaLLC/screenshot-studio/compare/v2.35.2...v2.36.0) (2026-10-22)


### Features

* **ui:** polish workspace, Phosphor icons, themes, and R2 images ([#291](https://github.com/PlaybookMediaLLC/screenshot-studio/issues/291)) ([5ce2436](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/5ce24369811db55103f560c48811b684cbcc3c8c))

## [2.35.2](https://github.com/PlaybookMediaLLC/screenshot-studio/compare/v2.35.1...v2.35.2) (2026-10-22)


### Bug Fixes

* **ci:** prevent browser dependency installation timeouts ([#289](https://github.com/PlaybookMediaLLC/screenshot-studio/issues/289)) ([8cc1f9a](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/8cc1f9a50bfb95bf32a54ee6ab77872c30ac9d58))

## [2.35.1](https://github.com/PlaybookMediaLLC/screenshot-studio/compare/v2.35.0...v2.35.1) (2026-10-22)


### Bug Fixes

* polish workspace navigation and home experience ([#287](https://github.com/PlaybookMediaLLC/screenshot-studio/issues/287)) ([62a3bf1](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/62a3bf1a8e3853095addb37df08c971c4f33bae6))

## [2.35.0](https://github.com/PlaybookMediaLLC/screenshot-studio/compare/v2.34.0...v2.35.0) (2026-10-22)


### Features

* implement the workspace UX redesign and template previews ([#284](https://github.com/PlaybookMediaLLC/screenshot-studio/issues/284)) ([1f79028](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/1f790288ec8ef3c70adfdd5d9f1f6435842b9761))

## [2.34.0](https://github.com/PlaybookMediaLLC/screenshot-studio/compare/v2.33.5...v2.34.0) (2026-10-22)


### Features

* expand the cloud marketing platform ([#281](https://github.com/PlaybookMediaLLC/screenshot-studio/issues/281)) ([a6500f6](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/a6500f60437a56d6f2155632984a6f8c03d9621f))

## [2.33.5](https://github.com/PlaybookMediaLLC/screenshot-studio/compare/v2.33.4...v2.33.5) (2026-10-22)


### Performance Improvements

* improve signed-in caching and data loading ([#279](https://github.com/PlaybookMediaLLC/screenshot-studio/issues/279)) ([fd23bc7](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/fd23bc713d4afd4e9bcc7294c22957822e4bf820))

## [2.33.4](https://github.com/PlaybookMediaLLC/screenshot-studio/compare/v2.33.3...v2.33.4) (2026-10-21)


### Bug Fixes

* resolve 95 QA findings across editors and workspace ([#277](https://github.com/PlaybookMediaLLC/screenshot-studio/issues/277)) ([14ee655](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/14ee655d925782c25b49574431c06f2e39da56e1))

## [2.33.3](https://github.com/PlaybookMediaLLC/screenshot-studio/compare/v2.33.2...v2.33.3) (2026-10-21)


### Bug Fixes

* prevent notification count clipping in sidebar ([#275](https://github.com/PlaybookMediaLLC/screenshot-studio/issues/275)) ([72f2f5c](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/72f2f5c1ac9988dd3647fafa86285e5ffc6995cd))

## [2.33.2](https://github.com/PlaybookMediaLLC/screenshot-studio/compare/v2.33.1...v2.33.2) (2026-10-21)


### Bug Fixes

* restore production releases and failing draft workflows ([#266](https://github.com/PlaybookMediaLLC/screenshot-studio/issues/266)) ([80a2c4b](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/80a2c4be38cb404a5568a1e5e1bbb8d950f4b12a))

## [2.33.1](https://github.com/PlaybookMediaLLC/screenshot-studio/compare/v2.33.0...v2.33.1) (2026-10-21)


### Bug Fixes

* **notifications:** retain seen activity and require explicit actions ([#272](https://github.com/PlaybookMediaLLC/screenshot-studio/issues/272)) ([6ce18bf](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/6ce18bf11102c2f1f429ef05fb5c988895168c06))

## [2.33.0](https://github.com/PlaybookMediaLLC/screenshot-studio/compare/v2.32.7...v2.33.0) (2026-10-21)


### Features

* **story-sets:** preview saved formats in library cards ([#269](https://github.com/PlaybookMediaLLC/screenshot-studio/issues/269)) ([fbfaf59](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/fbfaf5908900cb60025265f9ec46af6125c472c6))

## [2.32.7](https://github.com/PlaybookMediaLLC/screenshot-studio/compare/v2.32.6...v2.32.7) (2026-10-21)


### Bug Fixes

* **editor:** resolve image imports, autosave, and slide QA regressions ([#267](https://github.com/PlaybookMediaLLC/screenshot-studio/issues/267)) ([d8c15b7](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/d8c15b7ebda64ef45a15f71c8bf5bf3141af3844))

## [2.32.6](https://github.com/PlaybookMediaLLC/screenshot-studio/compare/v2.32.5...v2.32.6) (2026-10-21)


### Bug Fixes

* **link-preview:** preserve drafts and align audit results ([#264](https://github.com/PlaybookMediaLLC/screenshot-studio/issues/264)) ([b1c08bf](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/b1c08bf242eda7ab5b2ea0ae3e06e9ab6f31d0b7))

## [2.32.5](https://github.com/PlaybookMediaLLC/screenshot-studio/compare/v2.32.4...v2.32.5) (2026-10-21)


### Bug Fixes

* **assets:** correct library freshness, pagination, and previews ([#262](https://github.com/PlaybookMediaLLC/screenshot-studio/issues/262)) ([74750cc](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/74750cc199af4bda7845ea75cda409ebdad69351))

## [2.32.4](https://github.com/PlaybookMediaLLC/screenshot-studio/compare/v2.32.3...v2.32.4) (2026-10-21)


### Bug Fixes

* **canvas:** preserve edits and repair export and library workflows ([002ecab](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/002ecabd1b3ec94b5e7e215953694c31f033462c))

## [2.32.3](https://github.com/PlaybookMediaLLC/screenshot-studio/compare/v2.32.2...v2.32.3) (2026-10-21)


### Bug Fixes

* **projects:** isolate previews and recover library workflows ([#258](https://github.com/PlaybookMediaLLC/screenshot-studio/issues/258)) ([d0e8cea](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/d0e8cea893d71049f82a2a2aa579720e0d3ff6f5))
* **ui:** improve muted text, input, and keyboard focus visibility ([93397ca](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/93397ca63bc38e40d1401f70713a4173d3fb2ac9))
* **write:** preserve edits and repair draft controls ([#259](https://github.com/PlaybookMediaLLC/screenshot-studio/issues/259)) ([32d219f](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/32d219f85b53d8f784c9d3c480b19ce48561053a))

## [2.32.2](https://github.com/PlaybookMediaLLC/screenshot-studio/compare/v2.32.1...v2.32.2) (2026-10-21)


### Bug Fixes

* **workflows:** address workflow QA findings and add recoverable archives ([#253](https://github.com/PlaybookMediaLLC/screenshot-studio/issues/253)) ([ad41e0e](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/ad41e0e78c07fc9fc86b7c35b14264de911283ec))

## [2.32.1](https://github.com/PlaybookMediaLLC/screenshot-studio/compare/v2.32.0...v2.32.1) (2026-10-21)


### Bug Fixes

* **campaigns:** repair drafting, review, and campaign workflow ([#252](https://github.com/PlaybookMediaLLC/screenshot-studio/issues/252)) ([bee52be](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/bee52be39b7dc019b8032a42399b712902681c87))

## [2.32.0](https://github.com/PlaybookMediaLLC/screenshot-studio/compare/v2.31.2...v2.32.0) (2026-10-21)


### Features

* **settings:** complete workspace settings usability improvements ([#249](https://github.com/PlaybookMediaLLC/screenshot-studio/issues/249)) ([772e2fd](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/772e2fd165b4cba8d79adaf91be58aa5c47514eb))


### Bug Fixes

* **workflows:** resolve save errors and reduce page requests [skip ci] ([94d28e1](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/94d28e1ecaa231e77f063c7f45846f8364c4d3ea))

## [2.31.2](https://github.com/PlaybookMediaLLC/screenshot-studio/compare/v2.31.1...v2.31.2) (2026-10-21)


### Bug Fixes

* prefetch sidebar links on intent ([#246](https://github.com/PlaybookMediaLLC/screenshot-studio/issues/246)) ([9545bc0](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/9545bc08e79275a0128e96131dbc6da76747a070))

## [2.31.1](https://github.com/PlaybookMediaLLC/screenshot-studio/compare/v2.31.0...v2.31.1) (2026-10-21)


### Bug Fixes

* **story-sets:** resolve library and detail usability bugs ([#245](https://github.com/PlaybookMediaLLC/screenshot-studio/issues/245)) ([594a85d](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/594a85dee991478bb079bf37d88baaa5151f2012))

## [2.31.0](https://github.com/PlaybookMediaLLC/screenshot-studio/compare/v2.30.1...v2.31.0) (2026-10-21)


### Features

* **shell:** show the signed-in pages at 80% zoom ([#240](https://github.com/PlaybookMediaLLC/screenshot-studio/issues/240)) ([a6ac622](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/a6ac622c4eb2a8039d9e8281946ec67cc67e11c6))

## [2.30.1](https://github.com/PlaybookMediaLLC/screenshot-studio/compare/v2.30.0...v2.30.1) (2026-10-21)


### Bug Fixes

* **write:** preserve draft input and improve editor usability ([#242](https://github.com/PlaybookMediaLLC/screenshot-studio/issues/242)) ([2947db5](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/2947db5ace3d57382fb7740643eeb2ea6b739db6))

## [2.30.0](https://github.com/PlaybookMediaLLC/screenshot-studio/compare/v2.29.0...v2.30.0) (2026-10-20)


### Features

* **write:** promote calendar planning out of its experiment ([#237](https://github.com/PlaybookMediaLLC/screenshot-studio/issues/237)) ([5220c05](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/5220c05629051744d5c1b65497fc5421cc3e5fc2))

## [2.29.0](https://github.com/PlaybookMediaLLC/screenshot-studio/compare/v2.28.0...v2.29.0) (2026-10-20)


### Features

* **write:** the Write workspace (RFC 025) on the settings platform's social sets ([#234](https://github.com/PlaybookMediaLLC/screenshot-studio/issues/234)) ([1536b13](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/1536b13645b4e71c4031d6ec8cb1f74281e0db02))

## [2.28.0](https://github.com/PlaybookMediaLLC/screenshot-studio/compare/v2.27.1...v2.28.0) (2026-10-20)


### Features

* **canvas:** layers, components, presence, store groups, automation and vector PDF ([#231](https://github.com/PlaybookMediaLLC/screenshot-studio/issues/231)) ([43f4ed9](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/43f4ed90b62ed1212e896e972d06bf34c5f07b44))

## [2.27.1](https://github.com/PlaybookMediaLLC/screenshot-studio/compare/v2.27.0...v2.27.1) (2026-10-20)


### Bug Fixes

* **drafts:** drop a model's introduction from AI help, and record the settings verification ([#232](https://github.com/PlaybookMediaLLC/screenshot-studio/issues/232)) ([c08f468](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/c08f4684a9c1f9939da2cedbc908c45fbc5c6ba4))

## [2.27.0](https://github.com/PlaybookMediaLLC/screenshot-studio/compare/v2.26.0...v2.27.0) (2026-10-20)


### Features

* **settings:** social sets, preferences and webhooks in the backend (RFC 024, 1/2) ([#228](https://github.com/PlaybookMediaLLC/screenshot-studio/issues/228)) ([f1c5252](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/f1c5252c3c8f228024f6d91e96bf967101578db4))

## [2.26.0](https://github.com/PlaybookMediaLLC/screenshot-studio/compare/v2.25.0...v2.26.0) (2026-10-20)


### Features

* **canvas:** add the infinite Canvas workspace ([#225](https://github.com/PlaybookMediaLLC/screenshot-studio/issues/225)) ([5f65fc6](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/5f65fc66f1c79176bc250269ae7ac775da40f6a0))

## [2.25.0](https://github.com/PlaybookMediaLLC/screenshot-studio/compare/v2.24.5...v2.25.0) (2026-10-20)


### Features

* **workflows:** first-class workflows with AI relevance, rendered creatives, and flexible release definitions ([#224](https://github.com/PlaybookMediaLLC/screenshot-studio/issues/224)) ([4a3d28e](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/4a3d28e616bc3989272bc26a9cf2ca74bc7bd001))

## [2.24.5](https://github.com/PlaybookMediaLLC/screenshot-studio/compare/v2.24.4...v2.24.5) (2026-10-20)


### Bug Fixes

* **editor:** preserve undo state and align export checks ([#222](https://github.com/PlaybookMediaLLC/screenshot-studio/issues/222)) ([13b36b3](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/13b36b3019af8996a0c5f666156340b46549eab6))

## [2.24.4](https://github.com/PlaybookMediaLLC/screenshot-studio/compare/v2.24.3...v2.24.4) (2026-10-20)


### Bug Fixes

* **editor:** resolve live audit save and responsive editing bugs ([#220](https://github.com/PlaybookMediaLLC/screenshot-studio/issues/220)) ([bdf0e72](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/bdf0e721f7645b823d8286d3bf1dbd2a266cdfde))

## [2.24.3](https://github.com/PlaybookMediaLLC/screenshot-studio/compare/v2.24.2...v2.24.3) (2026-10-20)


### Bug Fixes

* **editor:** remove the SEO text below the editor ([#218](https://github.com/PlaybookMediaLLC/screenshot-studio/issues/218)) ([7b4cf94](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/7b4cf9428ddb838f535506dd563e5b97ef85873b))

## [2.24.2](https://github.com/PlaybookMediaLLC/screenshot-studio/compare/v2.24.1...v2.24.2) (2026-10-20)


### Bug Fixes

* **layout:** use available width across platform pages ([#216](https://github.com/PlaybookMediaLLC/screenshot-studio/issues/216)) ([b686397](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/b6863971772158b865725f44ea418486dadafebf))

## [2.24.1](https://github.com/PlaybookMediaLLC/screenshot-studio/compare/v2.24.0...v2.24.1) (2026-10-19)


### Bug Fixes

* **slack:** preserve parameters on read API calls ([#214](https://github.com/PlaybookMediaLLC/screenshot-studio/issues/214)) ([60beed8](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/60beed85f38895db5fcba0181351f239cb9e7f79))

## [2.24.0](https://github.com/PlaybookMediaLLC/screenshot-studio/compare/v2.23.0...v2.24.0) (2026-10-19)


### Features

* **notifications:** add workspace activity inbox and delivery ([#206](https://github.com/PlaybookMediaLLC/screenshot-studio/issues/206)) ([d51ef76](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/d51ef7629e60c444138e52f318a5925fc055944c))

## [2.23.0](https://github.com/PlaybookMediaLLC/screenshot-studio/compare/v2.22.0...v2.23.0) (2026-10-19)


### Features

* **creative-sets:** add connected Story Sets and polished product visuals ([#210](https://github.com/PlaybookMediaLLC/screenshot-studio/issues/210)) ([a53b4f6](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/a53b4f62e249aed1c741e336ca2c6e365c3b5778))

## [2.22.0](https://github.com/PlaybookMediaLLC/screenshot-studio/compare/v2.21.1...v2.22.0) (2026-10-19)


### Features

* add release workflows and standardize UI controls [skip ci] ([a69939a](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/a69939a5351a1198d40beb8262af17ab122d6598))

## [2.21.1](https://github.com/PlaybookMediaLLC/screenshot-studio/compare/v2.21.0...v2.21.1) (2026-10-19)


### Bug Fixes

* **editor:** integrate App Store studio and preserve editing state ([#204](https://github.com/PlaybookMediaLLC/screenshot-studio/issues/204)) ([f11ed22](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/f11ed2227241d3384577997c81038673a1510ceb))

## [2.21.0](https://github.com/PlaybookMediaLLC/screenshot-studio/compare/v2.20.0...v2.21.0) (2026-10-18)


### Features

* **drafts:** add the posting queue, calendar, approvals, share links, history and polls ([#197](https://github.com/PlaybookMediaLLC/screenshot-studio/issues/197)) ([e82aa79](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/e82aa791f4c7fea98963f64cb081ec367e7a19f3))

## [2.20.0](https://github.com/PlaybookMediaLLC/screenshot-studio/compare/v2.19.1...v2.20.0) (2026-10-18)


### Features

* **drafts:** write a draft as a thread and post it to X as replies ([#190](https://github.com/PlaybookMediaLLC/screenshot-studio/issues/190)) ([d655c10](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/d655c10e466e2cbc6c313486a72d5b80bcebebfe))

## [2.19.1](https://github.com/PlaybookMediaLLC/screenshot-studio/compare/v2.19.0...v2.19.1) (2026-10-18)


### Bug Fixes

* **deploy:** own the MCP host in the backend deploy and retire render-spec.py ([#191](https://github.com/PlaybookMediaLLC/screenshot-studio/issues/191)) ([89804c7](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/89804c72337759ab2d57716a3753da9e1ab0ab19))

## [2.19.0](https://github.com/PlaybookMediaLLC/screenshot-studio/compare/v2.18.0...v2.19.0) (2026-10-18)


### Features

* **drafts:** write a draft as the post it becomes ([#189](https://github.com/PlaybookMediaLLC/screenshot-studio/issues/189)) ([4f36e45](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/4f36e458cdc9c3019b41bf3cfa6beb675eda45c2))

## [2.18.0](https://github.com/PlaybookMediaLLC/screenshot-studio/compare/v2.17.0...v2.18.0) (2026-10-18)


### Features

* **api:** campaigns, approvals, and scheduled posts in /api/v1, entitlement tags, typed client, OpenAPI diff ([#152](https://github.com/PlaybookMediaLLC/screenshot-studio/issues/152)) ([55d762d](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/55d762dce1b1ab4ddd6f43ba9146239600922880))
* **mcp:** serve Shots tools from the Go MCP server ([#153](https://github.com/PlaybookMediaLLC/screenshot-studio/issues/153)) ([305b66b](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/305b66bafd57c2b783d4be183f63ddb2e67265cf))

## [2.17.0](https://github.com/PlaybookMediaLLC/screenshot-studio/compare/v2.16.0...v2.17.0) (2026-10-18)


### Features

* **drafts:** post tables and math blocks as images ([#180](https://github.com/PlaybookMediaLLC/screenshot-studio/issues/180)) ([1d3f1bf](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/1d3f1bf612abda52bca741015a50663d27bd7867))
* **drafts:** publish every image of a draft, up to each channel's limit ([#179](https://github.com/PlaybookMediaLLC/screenshot-studio/issues/179)) ([c2d3845](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/c2d38456303db2d726f6753686fa9d8bde546199))

## [2.16.0](https://github.com/PlaybookMediaLLC/screenshot-studio/compare/v2.15.0...v2.16.0) (2026-10-18)


### Features

* **onboarding:** add enrichment providers behind one interface ([#150](https://github.com/PlaybookMediaLLC/screenshot-studio/issues/150)) ([20d1eba](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/20d1eba3f1bfc1da26bc03464844ebf6066d1f7c))
* **onboarding:** add the onboarding-runs API and the review screen ([#155](https://github.com/PlaybookMediaLLC/screenshot-studio/issues/155)) ([024e357](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/024e35751f62eb884adfaa43f194cc8ac2f80927))
* **onboarding:** enrich through Exa, spend no AI credits, and show a progress card ([#167](https://github.com/PlaybookMediaLLC/screenshot-studio/issues/167)) ([7b02568](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/7b02568afb1c9eafd7941a76098efd85ee8bba1b))
* **onboarding:** run the background read as a Temporal workflow ([#149](https://github.com/PlaybookMediaLLC/screenshot-studio/issues/149)) ([21f8349](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/21f8349ded602a04ede459384004b80b0e967209))

## [2.15.0](https://github.com/PlaybookMediaLLC/screenshot-studio/compare/v2.14.0...v2.15.0) (2026-10-18)


### Features

* **drafts:** save comment threads with the draft ([#176](https://github.com/PlaybookMediaLLC/screenshot-studio/issues/176)) ([1ec9fef](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/1ec9fef05f3dfd6eb5f80e57602eb317d628e2ef))

## [2.14.0](https://github.com/PlaybookMediaLLC/screenshot-studio/compare/v2.13.0...v2.14.0) (2026-10-18)


### Features

* **onboarding:** add the onboarding models and the ideal customer form ([#145](https://github.com/PlaybookMediaLLC/screenshot-studio/issues/145)) ([55037d5](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/55037d51491a00d5116bc349b769fdbd4fd1fb69))

## [2.13.0](https://github.com/PlaybookMediaLLC/screenshot-studio/compare/v2.12.0...v2.13.0) (2026-10-18)


### Features

* **collab:** run the collaboration server as several replicas through Redis ([#171](https://github.com/PlaybookMediaLLC/screenshot-studio/issues/171)) ([6998e26](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/6998e261aba86b8958430368f91966647e68b743))

## [2.12.0](https://github.com/PlaybookMediaLLC/screenshot-studio/compare/v2.11.0...v2.12.0) (2026-10-18)


### Features

* **deploy:** ship content drafts and the collab service to production ([#170](https://github.com/PlaybookMediaLLC/screenshot-studio/issues/170)) ([acabcee](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/acabcee6c89f553ac7eb737460cb870d48c234e0))

## [2.11.0](https://github.com/PlaybookMediaLLC/screenshot-studio/compare/v2.10.2...v2.11.0) (2026-10-18)


### Features

* **billing:** calculate sales tax with Stripe Tax at checkout ([#172](https://github.com/PlaybookMediaLLC/screenshot-studio/issues/172)) ([1c11e59](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/1c11e590bffc07853711a8987cf1146667ae337d))


### Bug Fixes

* **marketing:** remove self-hosting claims from the security page ([#173](https://github.com/PlaybookMediaLLC/screenshot-studio/issues/173)) ([16c93e5](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/16c93e55ac033f2899c03ed46ed2da4dbb7a816d))

## [2.10.2](https://github.com/PlaybookMediaLLC/screenshot-studio/compare/v2.10.1...v2.10.2) (2026-10-18)


### Bug Fixes

* **infra:** make the backend internal-only ([#177](https://github.com/PlaybookMediaLLC/screenshot-studio/issues/177)) ([67942f1](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/67942f187f5ddcbd8fbb873d92a818c3ba006337))

## [2.10.1](https://github.com/PlaybookMediaLLC/screenshot-studio/compare/v2.10.0...v2.10.1) (2026-10-18)


### Bug Fixes

* compliance fixes from the legal audit (consent, AI privacy, renewal notice) ([#157](https://github.com/PlaybookMediaLLC/screenshot-studio/issues/157)) ([08c04d4](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/08c04d4aeea17ecce94cdea85b500f2c2bb42155))

## [2.10.0](https://github.com/PlaybookMediaLLC/screenshot-studio/compare/v2.9.0...v2.10.0) (2026-10-18)


### Features

* **drafts:** add content drafts to the Go backend, SDK and /api/v1 ([#163](https://github.com/PlaybookMediaLLC/screenshot-studio/issues/163)) ([6e8c07b](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/6e8c07be20ac4158c3038cfa40d9737d498b6ec0))
* **drafts:** add the draft composer and live co-editing behind PLATFORM_CONTENT_DRAFTS ([#165](https://github.com/PlaybookMediaLLC/screenshot-studio/issues/165)) ([2e6469e](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/2e6469ef852b86a7f18fd683b68bec8c94c9a1f7))
* **drafts:** schedule a content draft to several channels ([#164](https://github.com/PlaybookMediaLLC/screenshot-studio/issues/164)) ([6d3525f](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/6d3525ffc5007133a516231505ec578ad53a2c17))
* **editor:** inject uploads, AI and collaboration config into the editor package ([#162](https://github.com/PlaybookMediaLLC/screenshot-studio/issues/162)) ([9d9160c](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/9d9160ca33c3d33900695cc4f7256adeb2d79b69))
* **editor:** vendor the Plate.js editor package as @shots/platejs-editor ([#161](https://github.com/PlaybookMediaLLC/screenshot-studio/issues/161)) ([0052234](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/0052234e8b6f0be7d90ad40be8b7800d18f0b6ae))

## [2.9.0](https://github.com/PlaybookMediaLLC/screenshot-studio/compare/v2.8.0...v2.9.0) (2026-10-17)


### Features

* **billing:** enforce seat and channel limits and cut launch AI cost ([#148](https://github.com/PlaybookMediaLLC/screenshot-studio/issues/148)) ([0f2b474](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/0f2b474de239dab58bcea06cee57312921cd4fab))

## [2.8.0](https://github.com/PlaybookMediaLLC/screenshot-studio/compare/v2.7.1...v2.8.0) (2026-10-17)


### Features

* **editor:** complete the editor platform, UX fixes, and capabilities F01–F24 ([#137](https://github.com/PlaybookMediaLLC/screenshot-studio/issues/137)) ([03700f9](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/03700f94ce5d943a0e50e340ecdb20740717b590))

## [2.7.1](https://github.com/PlaybookMediaLLC/screenshot-studio/compare/v2.7.0...v2.7.1) (2026-10-17)


### Bug Fixes

* **sdk:** publish the store review methods as 0.1.16 ([#140](https://github.com/PlaybookMediaLLC/screenshot-studio/issues/140)) ([cd67c2a](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/cd67c2ae826190642e343fdde1b46ef05988ad83))

## [2.7.0](https://github.com/PlaybookMediaLLC/screenshot-studio/compare/v2.6.0...v2.7.0) (2026-10-17)


### Features

* **store-screenshots:** rebuild the store screenshot studio with export, review, and publishing ([#138](https://github.com/PlaybookMediaLLC/screenshot-studio/issues/138)) ([7df6ca5](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/7df6ca5f6274f13ab1f659c8df4e0b48f9445b2b))

## [2.6.0](https://github.com/PlaybookMediaLLC/screenshot-studio/compare/v2.5.0...v2.6.0) (2026-10-16)


### Features

* campaign chat, step traces, and an AI kill switch (Phase 2B) ([#135](https://github.com/PlaybookMediaLLC/screenshot-studio/issues/135)) ([7f3f522](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/7f3f522eed0704677610f70a51616ebeaf66df8a))

## [2.5.0](https://github.com/PlaybookMediaLLC/screenshot-studio/compare/v2.4.0...v2.5.0) (2026-10-16)


### Features

* agent tool runtime, run traces, and conversations (Phase 2A) ([#133](https://github.com/PlaybookMediaLLC/screenshot-studio/issues/133)) ([39025b5](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/39025b5bae97869091719f4840080f19c39b25cf))

## [2.4.0](https://github.com/PlaybookMediaLLC/screenshot-studio/compare/v2.3.0...v2.4.0) (2026-10-16)


### Features

* paste a URL, get seven launch posts ([#131](https://github.com/PlaybookMediaLLC/screenshot-studio/issues/131)) ([0e4c5fc](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/0e4c5fc5309abd31eecf7b8881e969a0af72b40a))

## [2.3.0](https://github.com/PlaybookMediaLLC/screenshot-studio/compare/v2.2.0...v2.3.0) (2026-10-16)


### Features

* schedule launch posts, enforce the brand, and add Phase 1 backends ([#129](https://github.com/PlaybookMediaLLC/screenshot-studio/issues/129)) ([a0838db](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/a0838db3fc6842229b1db56e848c62a9ce9b0687))

## [2.2.0](https://github.com/PlaybookMediaLLC/screenshot-studio/compare/v2.1.0...v2.2.0) (2026-10-16)


### Features

* complete the Phase 0 backend and the paywall experience ([#127](https://github.com/PlaybookMediaLLC/screenshot-studio/issues/127)) ([68450d7](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/68450d73bd90f45f70918a2cc6607de0150a03d8))

## [2.1.0](https://github.com/PlaybookMediaLLC/screenshot-studio/compare/v2.0.1...v2.1.0) (2026-10-16)


### Features

* **editor:** sleeker editor header and an always-collapsed sidebar ([#125](https://github.com/PlaybookMediaLLC/screenshot-studio/issues/125)) ([dc88e7e](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/dc88e7e9f02e7f7171f5b5656ba17e04e9c3872a))

## [2.0.1](https://github.com/PlaybookMediaLLC/screenshot-studio/compare/v2.0.0...v2.0.1) (2026-10-16)


### Bug Fixes

* require a paid plan on every tenant API call, and put the RFC plan in the README ([#122](https://github.com/PlaybookMediaLLC/screenshot-studio/issues/122)) ([d2482e6](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/d2482e60949d03a4574d44192af27917ff0d6c48))

## [2.0.0](https://github.com/PlaybookMediaLLC/screenshot-studio/compare/v1.23.0...v2.0.0) (2026-10-16)


### ⚠ BREAKING CHANGES

* webhook and maintenance callers must send X-Shots-* headers instead of X-Screenshot-Studio-*.

### Features

* rebrand as Shots, require a paid plan, and rewrite the site ([#118](https://github.com/PlaybookMediaLLC/screenshot-studio/issues/118)) ([eff29fb](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/eff29fbe2f9cf487cee97a83ff44cbbe5a30c964))

## [1.23.0](https://github.com/PlaybookMediaLLC/screenshot-studio/compare/v1.22.0...v1.23.0) (2026-10-16)


### Features

* **link-preview:** add the link preview workspace ([#114](https://github.com/PlaybookMediaLLC/screenshot-studio/issues/114)) ([91d90bf](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/91d90bfb57c6d9433a8e11084c3a1f6039dac2ee))

## [1.22.0](https://github.com/PlaybookMediaLLC/screenshot-studio/compare/v1.21.3...v1.22.0) (2026-10-16)


### Features

* **github:** connect a GitHub App and turn releases into launch briefs ([#106](https://github.com/PlaybookMediaLLC/screenshot-studio/issues/106)) ([d84357b](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/d84357b16876a3b892aadf72bf4fd387c0339fa4))

## [1.21.3](https://github.com/PlaybookMediaLLC/screenshot-studio/compare/v1.21.2...v1.21.3) (2026-10-16)


### Bug Fixes

* drop the internal port from the old-domain redirect ([#112](https://github.com/PlaybookMediaLLC/screenshot-studio/issues/112)) ([4142c59](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/4142c593692524adc4f3e623526ca06a946cd32d))

## [1.21.2](https://github.com/PlaybookMediaLLC/screenshot-studio/compare/v1.21.1...v1.21.2) (2026-10-16)


### Bug Fixes

* **deploy:** skip only images older than production, not commits behind main ([#110](https://github.com/PlaybookMediaLLC/screenshot-studio/issues/110)) ([af2c081](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/af2c081979acff398ccf2d2abfadeaabd48373bb))

## [1.21.1](https://github.com/PlaybookMediaLLC/screenshot-studio/compare/v1.21.0...v1.21.1) (2026-10-16)


### Bug Fixes

* **deploy:** keep secrets set on the app directly instead of failing ([#107](https://github.com/PlaybookMediaLLC/screenshot-studio/issues/107)) ([1bf789a](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/1bf789aaab132f23e6e584775fd9fa1c345c5970))

## [1.21.0](https://github.com/PlaybookMediaLLC/screenshot-studio/compare/v1.20.0...v1.21.0) (2026-10-16)


### Features

* meter AI credits, add Stripe billing, rebuild the site, and move to shots.playbookmedia.io ([#103](https://github.com/PlaybookMediaLLC/screenshot-studio/issues/103)) ([2471374](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/2471374759667a7c73bf6a443de4436ecc90ee14))

## [1.20.0](https://github.com/PlaybookMediaLLC/screenshot-studio/compare/v1.19.0...v1.20.0) (2026-10-15)


### Features

* **api:** centralize platform API routes on zod contracts and route() ([#100](https://github.com/PlaybookMediaLLC/screenshot-studio/issues/100)) ([7027b73](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/7027b7366e2d8e65520fa6ba1c7742df4d19d5b0))

## [1.19.0](https://github.com/PlaybookMediaLLC/screenshot-studio/compare/v1.18.0...v1.19.0) (2026-10-15)


### Features

* sync upstream video compressor, browser URL, and blank captures ([2cd4190](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/2cd4190ac0030a99f3f3929f6023a29b47fc1d1f))
* sync upstream video compressor, browser URL, and blank captures ([38ed2fe](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/38ed2fea17071b0b6a5ad2450dc8bb02b1618dd3))
* sync upstream video compressor, browser URL, and blank captures ([#99](https://github.com/PlaybookMediaLLC/screenshot-studio/issues/99)) ([2cd4190](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/2cd4190ac0030a99f3f3929f6023a29b47fc1d1f))

## [1.18.0](https://github.com/PlaybookMediaLLC/screenshot-studio/compare/v1.17.1...v1.18.0) (2026-10-15)


### Features

* render designs in Cloudflare Browser Rendering over CDP ([#94](https://github.com/PlaybookMediaLLC/screenshot-studio/issues/94)) ([bc73203](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/bc73203cec4debb73cdbdc3af01289ea468e85b8))

## [1.17.1](https://github.com/PlaybookMediaLLC/screenshot-studio/compare/v1.17.0...v1.17.1) (2026-10-15)


### Bug Fixes

* **deploy:** run social-migrate as the migration owner ([#95](https://github.com/PlaybookMediaLLC/screenshot-studio/issues/95)) ([3683df1](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/3683df1d8ea621bfd239e4c945b068c21ad0f8a3))

## [1.17.0](https://github.com/PlaybookMediaLLC/screenshot-studio/compare/v1.16.4...v1.17.0) (2026-10-15)


### Features

* move all web data access behind the backend SDK ([#92](https://github.com/PlaybookMediaLLC/screenshot-studio/issues/92)) ([38866b7](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/38866b771aceca956a142e4c97757808caff628e))

## [1.16.4](https://github.com/PlaybookMediaLLC/screenshot-studio/compare/v1.16.3...v1.16.4) (2026-10-14)


### Bug Fixes

* allow configured development tunnel origins ([#90](https://github.com/PlaybookMediaLLC/screenshot-studio/issues/90)) ([24a339a](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/24a339af3e0e7467362248c5b52befedbe874ea9))

## [1.16.3](https://github.com/PlaybookMediaLLC/screenshot-studio/compare/v1.16.2...v1.16.3) (2026-10-13)


### Bug Fixes

* pass social app credentials to local Go services ([#79](https://github.com/PlaybookMediaLLC/screenshot-studio/issues/79)) ([3f5d521](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/3f5d521fe58001a17918b4090d2e1b7a9022f19c))

## [1.16.2](https://github.com/PlaybookMediaLLC/screenshot-studio/compare/v1.16.1...v1.16.2) (2026-10-13)


### Bug Fixes

* retire Fly config and deploy web with trusted client IP ([#87](https://github.com/PlaybookMediaLLC/screenshot-studio/issues/87)) ([cd4e537](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/cd4e537851597da75fe66b8b1f3b730901899557))

## [1.16.1](https://github.com/PlaybookMediaLLC/screenshot-studio/compare/v1.16.0...v1.16.1) (2026-10-13)


### Bug Fixes

* deploy combined backend from repeatable GHCR tag ([#85](https://github.com/PlaybookMediaLLC/screenshot-studio/issues/85)) ([22f8d97](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/22f8d9706555846571006bc4a349602cfcd203d3))

## [1.16.0](https://github.com/PlaybookMediaLLC/screenshot-studio/compare/v1.15.0...v1.16.0) (2026-10-13)


### Features

* consolidate Screenshot Studio backend and maintenance jobs ([#83](https://github.com/PlaybookMediaLLC/screenshot-studio/issues/83)) ([1db7394](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/1db739418ebd8b3de9f4df6792af7c28b1e89264))

## [1.15.0](https://github.com/PlaybookMediaLLC/screenshot-studio/compare/v1.14.0...v1.15.0) (2026-10-13)


### Features

* **platform:** move maintenance to Go and Temporal, remove Trigger.dev ([#80](https://github.com/PlaybookMediaLLC/screenshot-studio/issues/80)) ([c2161b3](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/c2161b344bc6868cf14bbc854a50c36969842de0))

## [1.14.0](https://github.com/PlaybookMediaLLC/screenshot-studio/compare/v1.13.1...v1.14.0) (2026-10-13)


### Features

* run Screenshot Studio social API and worker in one backend ([#76](https://github.com/PlaybookMediaLLC/screenshot-studio/issues/76)) ([7a83bce](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/7a83bce2e31baae38b57b957f6405c5006b19e0a))

## [1.13.1](https://github.com/PlaybookMediaLLC/screenshot-studio/compare/v1.13.0...v1.13.1) (2026-10-13)


### Bug Fixes

* **renderer:** bound concurrent workload and cancel abandoned renders ([#77](https://github.com/PlaybookMediaLLC/screenshot-studio/issues/77)) ([386c429](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/386c429d969a2b73e3982588e6016d47599d60b2))

## [1.13.0](https://github.com/PlaybookMediaLLC/screenshot-studio/compare/v1.12.0...v1.13.0) (2026-10-13)


### Features

* **renderer:** migrate to TypeScript and add App Platform delivery ([47ea231](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/47ea2316f04c29922f71db7f54757a1d8bcbca47))

## [1.12.0](https://github.com/PlaybookMediaLLC/screenshot-studio/compare/v1.11.3...v1.12.0) (2026-10-13)


### Features

* **social:** bind Go tenants and verify OAuth publishing flows ([4651bae](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/4651bae76b039eec60b2baf69af468730a43c3fd))


### Bug Fixes

* **ci:** keep tenant binding script addable after clone ([e457df9](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/e457df9507959fb31d82b6e89b66d7b60a0ee1de))
* **dev:** ignore Conductor artifacts during lint ([5578edf](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/5578edfbd4486619c8d854682ede0b9ef0f29860))

## [1.11.3](https://github.com/PlaybookMediaLLC/screenshot-studio/compare/v1.11.2...v1.11.3) (2026-10-13)


### Bug Fixes

* **publishing:** reconcile Go receipts before marking posts published ([#68](https://github.com/PlaybookMediaLLC/screenshot-studio/issues/68)) ([ced38e4](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/ced38e446995cd610166c0fb29c74bdfd6255388))

## [1.11.2](https://github.com/PlaybookMediaLLC/screenshot-studio/compare/v1.11.1...v1.11.2) (2026-10-13)


### Bug Fixes

* handle private media for X and Instagram posts ([#66](https://github.com/PlaybookMediaLLC/screenshot-studio/issues/66)) ([b376f81](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/b376f813ba6694f888eb39886e640db854ca6192))

## [1.11.1](https://github.com/PlaybookMediaLLC/screenshot-studio/compare/v1.11.0...v1.11.1) (2026-10-13)


### Bug Fixes

* sign private social media when scheduled posts publish ([#63](https://github.com/PlaybookMediaLLC/screenshot-studio/issues/63)) ([4fa4983](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/4fa49834215d15f59dc45950b669f8b2ade72d63))

## [1.11.0](https://github.com/PlaybookMediaLLC/screenshot-studio/compare/v1.10.1...v1.11.0) (2026-10-12)


### Features

* validate LinkedIn OAuth and live publishing through Go backend ([#61](https://github.com/PlaybookMediaLLC/screenshot-studio/issues/61)) ([9b4ed6c](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/9b4ed6cee00cd327a3ea84614a50b7ca894bf3fc))

## [1.10.1](https://github.com/PlaybookMediaLLC/screenshot-studio/compare/v1.10.0...v1.10.1) (2026-10-12)


### Bug Fixes

* set internal URL for the social Go services ([#59](https://github.com/PlaybookMediaLLC/screenshot-studio/issues/59)) ([7d0e9f3](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/7d0e9f301e52013a514e482c9c7b7d159f6ddc84))

## [1.10.0](https://github.com/PlaybookMediaLLC/screenshot-studio/compare/v1.9.0...v1.10.0) (2026-10-12)


### Features

* add the social publishing services to the Screenshot Studio backend ([#57](https://github.com/PlaybookMediaLLC/screenshot-studio/issues/57)) ([07a1e45](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/07a1e45f8c3a4046aee60e2100d93d666788e785))

## [1.9.0](https://github.com/PlaybookMediaLLC/screenshot-studio/compare/v1.8.2...v1.9.0) (2026-10-09)


### Features

* Week 01 product connection, first campaign shell, and Playbook Core bootstrap ([#54](https://github.com/PlaybookMediaLLC/screenshot-studio/issues/54)) ([c5d738d](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/c5d738d238a7b881c8d87e0ac6edd1737e72a56b))

## [1.8.2](https://github.com/PlaybookMediaLLC/screenshot-studio/compare/v1.8.1...v1.8.2) (2026-10-04)


### Bug Fixes

* **local:** replace MinIO with RustFS for the local object store ([e4d4911](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/e4d49110eb42f9d21f3676362a996c08dcd5b043))
* **local:** replace MinIO with RustFS for the local object store ([8b8dd21](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/8b8dd219ba39157de719c10754adf495651e9c51))

## [1.8.1](https://github.com/PlaybookMediaLLC/screenshot-studio/compare/v1.8.0...v1.8.1) (2026-10-04)


### Bug Fixes

* **seo:** refocus free screenshot editor and animation maker pages on their core queries ([086d250](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/086d25063b9d9e2d01ee6615f9dcdd514feb1fdb))

## [1.8.0](https://github.com/PlaybookMediaLLC/screenshot-studio/compare/v1.7.0...v1.8.0) (2026-09-28)


### Features

* 3D tilt, shadow and corner radius for image overlays; list main image in Layers ([f43d4f6](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/f43d4f663cc33c464c918614cf7373016a45e2ff))
* add blur-up background loading and stable pre-hydration canvas in editor ([707c6dc](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/707c6dcfd748c0490c7b8d98a35f57d3816fc7eb))
* add clicks.page analytics script ([5ebeaea](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/5ebeaea31943092ab622db36a327ad042b359cd1))
* add editor presets, image controls and shortcut reference ([8c10dd9](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/8c10dd9ee7171f132ca62b653abc168f1ba2e6ed))
* add mosaic style for blur regions ([dc2c42d](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/dc2c42dc3419750038e8bbf2f429ab22286e4779))
* add mosaic style for blur regions ([0246323](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/02463231ef0854f5d9452bc22a030f7d0f74fa8c))
* add text-only graphics and Chrome Web Store presets ([c07d2f9](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/c07d2f9aa39e510891624b32d6053d4966e4872a))
* add tool chooser at / and move screenshot editor to /editor ([fb1c319](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/fb1c3196fbdc913b35feb7cac4ef022bb8b5cd49))
* add tweet to image editor at /tweet and remove Code Images card from editor ([ca3b590](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/ca3b590d8b537f3691fce2a978b4cbe9cb26ce52))
* **adsense:** add original content, rewrite privacy policy, limit ads to content pages ([419228f](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/419228f56e924e08c2707ad4bcd486adf65c9e80))
* **footer:** add Featured on UsefulShelf badge ([c215764](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/c21576402d4c51d16d09bbf3f03fff45c6afd88d))
* **footer:** use Screenshot Studio listing badge from UsefulShelf ([ec47161](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/ec47161a18c7aa015b5be718f77d7c39a4ce62f2))
* **guides:** redesign the guides hub, guide pages, and Resources menu ([127b437](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/127b4370eb836628b69a5302364456030565ee50))
* **nav:** add Blog link to guides and redirect /blog to /guides ([220509a](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/220509a59294bb18dc16a317c4e39b4a90b84215))
* redesign feature pages and free screenshot editor page with SEO alternative blocks ([08acf84](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/08acf84ab839456f5d8b275f29926660ac58f398))
* redesign image tools hub, tool pages, and background remover ([05d5b99](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/05d5b99690c96d5ee0183cc48a3170365d0b9f44))
* remove tweet import from editor sidebar and match code and tweet page FAQs to image tools ([fc90805](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/fc908057d6bfcaedd4d5ee4862b70dae6a42964c))
* **seo:** add 13 how-to guides and Screely roundup, redesign compare and guide pages ([b459e64](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/b459e643048cd784ce689a623b9bc43499e86227))
* **seo:** add mockup generator, guides hub, and accurate comparisons for AI search visibility ([acf9a7f](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/acf9a7ffa77f4d6441724c3f9b57df418fe08941))
* **seo:** submit only changed pages to IndexNow after each production deploy ([9839fdb](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/9839fdb8c0e8b822fe4b71bb29881c8dec0880c5))
* simplify tool chooser with plain task cards ([cfc7e05](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/cfc7e05d1b0e0bc11cd2dadd86900373da01ce76))


### Bug Fixes

* **adsense:** open editor workspaces from content pages with a full page load so the ads script never carries over ([ed49ba5](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/ed49ba5fcfd1290f2e63074f512c49c875c9b444))
* keep image paste in editor and restore keyboard history ([f6ad58d](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/f6ad58d412f8af065e1dbf8a6257985d3fa4345a))
* keep overlay selection transient and safe across edits ([f734ec3](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/f734ec33912f70775b133ba668861f1677a7ee99))
* **mockups:** keep Dynamic Island mask aligned with frame ([c2dd22e](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/c2dd22e12ea666fa5e96b070dce929dc5e239de9))
* **mockups:** preserve screenshot viewport when extending mask ([a42010b](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/a42010b761aa38c5af1156feb0d230e0a3323384))
* **mockups:** repair iPhone frame mattes and edge coverage ([082b2e3](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/082b2e3030f205d1f9c2b43c1453f21564f87942))
* **privacy:** scope the EEA consent description to ad personalization and name the revocation link ([141941a](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/141941a518e635af76107cbae1ea1fe5eab39b58))
* **seo:** link tools and guides site-wide, accurate sitemap lastmod, redirect dead URLs ([8278981](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/82789819c0cbb3acf7beb72b9e92a9c6f60dc6b8))
* **seo:** track the IndexNow script that the workflow and test import ([366feab](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/366feabf8a29b759f52fcdb8cc302ef9a154530d))
* show full GitHub star count instead of abbreviated K ([ca0db40](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/ca0db4071d697a8cd5e19107d1f8b90b7d9f5bf2))


### Reverts

* remove Monetag ad script, meta tag, and sw.js ([9939739](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/99397394b981398d4934278f95f802c45011ab73))

## [1.7.0](https://github.com/PlaybookMediaLLC/screenshot-studio/compare/v1.6.0...v1.7.0) (2026-09-22)


### Features

* add App Store screenshot workflow ([33feeba](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/33feeba7ebddd22dd6ca9e9dc2f927e66abc0d8c))
* **editor:** add image and animated templates ([83a113a](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/83a113a3f400279980f1156096ed9c6f0c1ea957))
* **editor:** add image and animated templates ([eb1b29f](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/eb1b29fc840975598e53041444362388bdfcf63e))
* **store-screenshots:** add App Store screenshot workflow ([40cd148](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/40cd14846672c98810fbd91482d861bfa54bec95))
* **timeline:** simplify animation timeline ([ca14401](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/ca14401818ab85f2297aa338f339fcd3d9769003))
* **timeline:** simplify animation timeline ([1ffb6a7](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/1ffb6a7f303f33f940408a1e233f6933135e51d2))


### Bug Fixes

* **auth:** suspend search parameter forms ([e669b74](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/e669b745877b005a7315d10f7ed8981f44dedfe2))
* **seo:** resolve the full site audit ([53f262f](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/53f262f903b1346faa62febb11f41db10a57a130))

## [1.6.0](https://github.com/PlaybookMediaLLC/screenshot-studio/compare/v1.5.0...v1.6.0) (2026-09-02)


### Features

* add device mockups ([d20c7bd](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/d20c7bdfd128e79a5ed560035ecbcd8b624c24a4))
* add device mockups ([7b2f9f7](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/7b2f9f76711a1c6ce15584d94e15daac50457f65))


### Bug Fixes

* **publishing:** stop TestCreateScheduledPost expiring on a hardcoded date ([f6dab02](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/f6dab022ad6ddc8a1a781c12d8c2824b51f4f394))

## [1.5.0](https://github.com/PlaybookMediaLLC/screenshot-studio/compare/v1.4.0...v1.5.0) (2026-08-31)


### Features

* **publishing:** complete the Temporal publishing guarantees ([#40](https://github.com/PlaybookMediaLLC/screenshot-studio/issues/40)) ([e539ebc](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/e539ebc1d0b46a0eaad2927cc0ae0daaa1a14a32))

## [1.4.0](https://github.com/PlaybookMediaLLC/screenshot-studio/compare/v1.3.2...v1.4.0) (2026-08-31)


### Features

* **publishing:** add Go backend and orchestrator ([de08504](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/de08504012b99fb1f415ccef6ca5d8852334a9ea))
* **publishing:** add Go backend and Temporal orchestrator ([e0f1005](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/e0f10054087e86ffa9cb239505251dc767743355))
* **publishing:** replace poller with Temporal workflows ([7bf8a54](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/7bf8a54e7c21b94e3ba02d6ce3ec18cd0d102aa2))

## [1.3.2](https://github.com/PlaybookMediaLLC/screenshot-studio/compare/v1.3.1...v1.3.2) (2026-08-27)


### Bug Fixes

* **workspace:** stop a slow transaction returning 500 on a valid request ([#33](https://github.com/PlaybookMediaLLC/screenshot-studio/issues/33)) ([6f69cae](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/6f69cae70212c927645c88f4563bf11ce784be86))

## [1.3.1](https://github.com/PlaybookMediaLLC/screenshot-studio/compare/v1.3.0...v1.3.1) (2026-08-26)


### Bug Fixes

* **tenant:** stop plan gates leaking other workspaces' asset ids ([#29](https://github.com/PlaybookMediaLLC/screenshot-studio/issues/29)) ([adeea1f](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/adeea1f785d9c6b78404d01625cb6010d68162de))

## [1.3.0](https://github.com/PlaybookMediaLLC/screenshot-studio/compare/v1.2.0...v1.3.0) (2026-08-26)


### Features

* **api:** gate REST features by workspace plan ([aeda832](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/aeda832d3bee754548789db06ac9807d4d12a319))
* **api:** require Zod schemas for REST routes ([6bf0359](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/6bf03590836601942b613e227182ef9267dbf50b))
* **billing:** harden workspace entitlements ([44104d8](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/44104d83c2f5455068a990ac97aba2d1cf20fe06))
* ship enterprise-ready Scalar REST API framework ([9c870cc](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/9c870ccb5fa4396cabe9aae36947e5b055d26dc5))

## [1.2.0](https://github.com/PlaybookMediaLLC/screenshot-studio/compare/v1.1.0...v1.2.0) (2026-08-26)


### Features

* add Databuddy analytics tracking to root layout ([0497101](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/0497101b503c19701e74707b73ec08e2368b0712))
* add extensible v1 REST framework ([c40a555](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/c40a555d457c65c9815dde94df949aa31beb19df))
* add GA4 gtag to root layout ([c0eee43](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/c0eee435c2bd8a9c836b9572910e6dc3fcf9ec7c))
* add Scalar REST API reference ([53ab217](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/53ab21782c9fbc7a06aadffe4d8cc9d23345b297))
* agent readiness, canonical www host, and a truthful privacy policy ([b9c12b1](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/b9c12b1956c9000beb305bbf76ba96d5fd9f929c))


### Bug Fixes

* **ci:** ignore imported upstream commit messages ([850c956](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/850c9568cf5c1098e59d2cf395fbe45256db3161))
* **export:** exclude editor overlays from export ([1228469](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/122846942792386666da1570c7959720bf57a4e8))
* **export:** exclude editor overlays from export ([36669b8](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/36669b868670f0204e3a76886d2348fb48ef7502))

## [1.1.0](https://github.com/PlaybookMediaLLC/screenshot-studio/compare/v1.0.2...v1.1.0) (2026-08-20)


### Features

* complete workspace administration ([#21](https://github.com/PlaybookMediaLLC/screenshot-studio/issues/21)) ([1ee39f2](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/1ee39f2cb3ac1c843cd147515d8d97cd1b827b5f))

## [1.0.2](https://github.com/PlaybookMediaLLC/screenshot-studio/compare/v1.0.1...v1.0.2) (2026-08-19)


### Bug Fixes

* clear production console errors and unblock browser uploads ([#19](https://github.com/PlaybookMediaLLC/screenshot-studio/issues/19)) ([5753570](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/5753570ee16f5c4e9d58628eaf8dea3af5476c1f))

## [1.0.1](https://github.com/PlaybookMediaLLC/screenshot-studio/compare/v1.0.0...v1.0.1) (2026-08-19)


### Performance Improvements

* **ci:** parallelize jobs and cache builds ([#17](https://github.com/PlaybookMediaLLC/screenshot-studio/issues/17)) ([23da28e](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/23da28e749f60c3e88f824da261b07e55af37ef4))

## 1.0.0 (2026-08-19)


### Features

* 3D frame rendering based on transform state ([71adf81](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/71adf81c803f640bf371098ed062aa3ad1371a0a))
* add /api/llms and /api/llms-full routes serving documentation and update layout links ([188077f](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/188077fc822194246f641dcd3f317e74bc2978b7))
* add 3D frame overlay, renderer, and image loading hook to canvas ([03368b3](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/03368b30e3c1ba734c39d7d89df98868e89fbb16))
* add 3D perspective controls and transform logic to canvas rendering ([fcb0cd9](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/fcb0cd9507710e97b4e7f6f57e790f217d2012a5))
* add ai-seo skill with docs, references, evals and update landing page, layout, robots, sitemap ([5d08878](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/5d0887895c6b2f86ebc3b8f41303c12ee5a50d31))
* add annotation tools, text overlay revamp, webp export support, UI polish ([6428a16](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/6428a16dfc05ee713e8c2210569f2b73e1c43026))
* add arrow gallery for image overlays ([1a89ef2](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/1a89ef2b8c8908ad83f21bb08a7b5e70cdabdba5))
* add aspect ratio picker and dropdown to editor UI ([0260944](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/0260944831d8491a6cc10600ba0cec5384baba93))
* add BackedBy component to landing page ([f3fc7af](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/f3fc7afce1963c85fa8d2515c97589852fa0ecf3))
* add BackedBy component to landing page and Vercel OSS badge to README ([fd14a5e](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/fd14a5e02df041c602212a75aeb54843bb2bcf54))
* add background blur and noise controls to editor ([8632ef0](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/8632ef0ca710035a96f4a0bfbead44deb4779ac8))
* add background blur and noise support to presets and selector ([34eadd2](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/34eadd2f4a700c081c6a9e4761a20b45cc83cbed))
* add background blur support to canvas background dialog ([1e2133c](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/1e2133c794629fd7f1a559cd24e1aa0b1f8c3e09))
* add background customization and export to data URL in canvas editor ([6e9bbdb](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/6e9bbdb5c5fdcf81c2366e068bad0e5a300d2162))
* add border and shadow controls to image editor ([0dc776e](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/0dc776e52a341c5c44f2084d48614e009a391286))
* add border radius and image scale controls to editor and update background rendering ([12a3b54](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/12a3b544300859ebac430083bab1542a3473318c))
* add browser mockups feature page and UI updates ([6adb06a](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/6adb06a640381a248fa37bd1b55a3c81f45b5e01))
* add canvas background layer, image loading hook, home page metadata, and icons ([e6313c3](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/e6313c32e3e0c6717bae9d78ed0fd30f2dc319e2))
* add canvas export functionality for video encoding and enhance slide rendering with improved DOM image update handling ([f80394b](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/f80394b2bf42962fcaaed32827590bf90a260756))
* add canvas rulers and grid with customizable intervals ([71f9508](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/71f9508b2f8b0bf95cf433287000a1a01f3ef635))
* add canvas rulers and grid with customizable intervals ([b470183](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/b47018315dfcc8399a51dd8c8d23ac62db46025a))
* add canvas toolbar with upload, text, color, export and background scaling ([692840b](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/692840bf67e3c7a4c83e4dd51587f710a9716429))
* add color picker, custom background options, and shadow overlay handling to BackgroundSection ([8ddf890](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/8ddf890d302785b6bb36a3866a38554ecd53a57b))
* add comparison page with SEO, JSON‑LD, sitemap, robots; update README links ([f598f62](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/f598f62f0f08279cf89575f4a60f69ddab39c753))
* add copy image button and export hook to editor left panel ([78d46fb](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/78d46fb59a3d087b6fd37d34eb6053257822d995))
* add dark mode support to screenshot API ([c2c0e12](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/c2c0e12768cd28f8d1b88d8f111b39021a8197fe))
* add Databuddy analytics script to app layout ([6df547e](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/6df547eff227758ac22f3ccef62505c581797eee))
* add designs gallery page and API for saving and retrieving designs ([e48e1fb](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/e48e1fbd7ef46cb0b85eebada361679292fe4ca2))
* add device type selection for website screenshot capture ([ade6097](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/ade6097cf7d86be393e97bcbc48d6dd02f60fa43))
* add drag-and-drop functionality to text and image overlays ([5788c96](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/5788c96812eb569c7b8743e396381df2a606b2e7))
* add editor header, content, layout and upload area components ([700d4e1](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/700d4e195a33a7f059a492b536c74a7e9d63aacf))
* add enterprise workspace platform ([#2](https://github.com/PlaybookMediaLLC/screenshot-studio/issues/2)) ([352d89a](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/352d89a7dfb361ac5c080d837e29dcd2b5193844))
* add export API route with Sharp and UI for format/quality selection ([a4e8868](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/a4e8868cfeea3db9ab388ac0387e084f0d87805a))
* add export dialog with format, quality, and scale controls to editor ([ae3d97f](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/ae3d97f5c8b3eaf12452f5a5ec224a5025b8882d))
* add export dialog with progress UI and simulated export hook ([9196645](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/91966457eb831ede41cf5d341a2455e9493fbc4a))
* add export preferences and scale support to export dialog and sidebar ([7faf1df](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/7faf1dff5c3c1de0b6e11463041e48b44fabc7ac))
* add export success toast, confetti celebration, custom toaster, and simplify copy button ([52fb50e](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/52fb50e3a92146eaac0a338e662c09804b4f7959))
* add export, copy, and dialog features to editor canvas and improve UI ([5763357](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/5763357ccf46b681bfec3feb340e57387604f77b))
* add FAQ section with accordion to landing page ([65d9f56](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/65d9f56bee1acdee9f67fbfc8d53ae3d0bb58f71))
* add feedback widget to editor header ([600ddb2](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/600ddb2ff7984e8aca1778f174244563a10b06be))
* add free screenshot editor page with metadata and changelog entry ([20e9ad4](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/20e9ad46a15fd1fbc4aaf07e92aa72d73e901297))
* add GitHub link to footer and navigation ([e88bf21](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/e88bf21830893c130e146958e80662d1cf10f0f1))
* add GitHub stars fetch and display in navigation ([cdf907b](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/cdf907bc4d5f3961908e8a1c2c20a561e2ef7ecc))
* add GitHub stars fetch hook to editor bottom bar ([08c33d7](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/08c33d77e57652403b901b7f3fad018c8e1efc21))
* add glass, outline, and border frame styles and update editor sections ([05ecdb7](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/05ecdb7e10f0edbdb09215922d52dbbc41556148))
* add Google OAuth sign-in, sign-up, and protected editor page with session validation ([ca717c6](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/ca717c68f2ec5a6122589ea452ebc2d50abd1dab))
* add hero video dialog component and integrate into landing hero ([96bf4ae](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/96bf4ae428d46415897cc7dc20d414265134e353))
* add image showcase builder editor with canvas, controls, templates, and error boundary ([e5a1232](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/e5a12329de1d9333ee5931740f783266c033f503))
* add iwatch, imac, macbook mockup renderers and update mockup constants ([e31c9c1](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/e31c9c110ed8fffc425ce65f52489a63e9ce5473))
* add Kanak Kumar Mahala as sponsor on landing page ([aff3637](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/aff36379aefe8932602b8a05d971b7ef1bea0449))
* add Karan Kendre and Pranav Patil sponsors to landing page and update grid layout ([c3d36dd](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/c3d36dd04283474f8f980a98880ad3c0d8e5567f))
* add konva transformer to transform images and text ([0db5c16](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/0db5c1625944038c4c4980d6aa9246c7a9be85ee))
* add konva transformer to transform images and text ([4fff001](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/4fff001633a7de3c638efeeb3df863180fbe6e29))
* add landing page with feature list and redirect root to home ([3b8ac61](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/3b8ac61dd05f92cb4bc072786e2fd65167635cf7))
* add landing page with features, FAQ, CTA, draft storage, and autosave ([7be54f8](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/7be54f80bb153245881b0e0aa1da38f79bd05b19))
* add landing page with hero, features, navigation, and footer ([4d51a4d](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/4d51a4d12f97ff36edd28e39d6f4be795660560a))
* add local SaaS development stack ([9c82c81](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/9c82c810ce179d789c90bb3da634aeaf55b9a281))
* add manual screenshot cache cleanup API and update docs ([eacbd4b](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/eacbd4b6d956281f253563f04d8af0270739d123))
* add mobile header and responsive panels to editor layout ([541c4c0](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/541c4c06e92d65240477a887785297c03cc782e5))
* add mockup gallery, controls, and renderer to editor ([d86d90d](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/d86d90da3cedead74bfa1ce2f21329edc4450b81))
* add moving-border button component and update sponsor button styling ([cf97eca](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/cf97eca09215eaf861c0682bed2686fe5c9051b1))
* add new pages for changelog, compare, about, terms, privacy, contact, and feature sections ([b522665](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/b5226659d1b945a4dc0be75e193a5768755051f6))
* add open source link button and logo link to editor UI ([4148158](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/4148158d49e08c6adc9d6e694895a5da8db2b78e))
* add options to define background color using HEX or RBGA values ([cca1ec7](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/cca1ec70e1b803cdb8b0e18b12f9ea527edb85d2))
* add options to define background color using HEX or RBGA values along with the color picker ([93e0c14](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/93e0c14b473b604dfd0d44297f2ae1cec00344e6))
* add overlay gallery, controls, renderer, and integrate into editor and canvas ([2629e23](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/2629e23122b08e88827e2ecb05717204e6883f54))
* add overlay image support to editor with depth section and moveable controls ([234f902](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/234f902a99a347bb694de6b33eba2788798d3f77))
* add overlay resize handles, custom presets, and arc frame controls to canvas editor ([a489185](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/a489185f326b315ee2cb909d37f611f0639dc3f6))
* add overlay shadows gallery to editor left panel ([74eccc3](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/74eccc31d4069f08b1120c2c246a1e9fddff9f29))
* add payment checkout flow with Polar integration ([6b9b8f9](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/6b9b8f95d2335da7b8905e9fcba4dc27bdd97007))
* add payments checkout flow, status API, auth integration, schema updates, and docs ([2b42ed0](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/2b42ed0bd22f3b9d5ca3571bf4415761da5f38ac))
* add Peerlist Project Spotlight link to footer ([c483fa8](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/c483fa8b51bdbe45efaec6961d3df13bfaa03c4f))
* add persistent image storage and background preferences to canvas ([3567553](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/356755388a34e06e6a387e9581c814fce2a8733b))
* add preset background images to CanvasToolbar and improve CanvasEditor image handling ([6cd24a9](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/6cd24a92345a4ae06f1547cf4208073b5b4f0e33))
* add preset gallery to editor right panel ([dfb4a22](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/dfb4a224ee29082dd3b34480a58fed72ab3b5fec))
* add preset shadows UI and default image shadow settings ([444ff53](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/444ff5335e02570cb6567cd75dc6d94370dfb823))
* add presets selector, improve editor UI and mobile styling ([bd941b2](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/bd941b26fd85bb9667bdca51323231f1e1e6c77f))
* add Product Hunt badge to Hero and update CTA label ([01f0df3](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/01f0df32e02ffa829674277fe00cb29f9459888e))
* add quick-select aspect ratio dropdown and improve UI components ([871eff7](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/871eff745c7e4a1559f68e0a2f4a45574c628ed9))
* add Safari & Chrome browser mockup frames with toolbar, header slider, custom URL ([2c6a89c](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/2c6a89cca13e5b80300232392d6cd390af14ae8d))
* add save dialog with name, description, and error handling to sidebar-left editor ([9b30d69](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/9b30d6985edeab5cd0b8e1c0b1ce991e90f9464c))
* add screenshot API using Puppeteer and @sparticuz/chromium ([c92c5cd](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/c92c5cdaf338fc1e68ed7e82d9a55c05a5ebe5cc))
* add screenshot API using Puppeteer and @sparticuz/chromium ([7679d0c](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/7679d0c8cde262e2c2b58d74669faa26b6bb72a1))
* add screenshot microservice and update API to use it ([a34f46f](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/a34f46f67f8e0a95ad250ed7f3a7d1d68dabd74c))
* add slide upload button to EditorCanvas ([c4cae62](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/c4cae62f654bf978893b1b3db0d5270239d2c22a))
* add social media aspect ratio presets and special dimensions ([2ec0bb5](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/2ec0bb57a799f9e09c99aa78cf0335e217dc8dcb))
* add SponsorButton component and integrate into editor bottom bar and landing page ([65d0345](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/65d03455326a0673ae5f89965cd0e2a1200717bd))
* add sponsors Fardeen Mansoori and Atharva Mhaske to landing page ([cef4585](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/cef4585f5f8742bc8bca6c323942e680fca4f4f2))
* add sponsors section to landing page ([989ca41](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/989ca41fa266f1a683921735d55353049ac98bdc))
* add Stage watermark to exported images ([39a1ba5](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/39a1ba5343c22933f1972fd86250eb1ad444dd05))
* add static background image support and Picsum fallback to CanvasToolbar ([abf44fd](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/abf44fd7df3753bbb4ab75ec97dad83cef0f98c5))
* add text overlay rendering to client canvas ([00f91be](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/00f91bee587157eb7f8f894c17997e9e66ded40d))
* add timeline editor and animation presets ([0be3c5d](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/0be3c5d7c55b63f7b01611af25e2933ec1c0d981))
* add transform dialog and elevation controls to canvas objects ([1dc4755](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/1dc4755114fbfc8fd8baed0669bb3ae37e0f607c))
* add transforms gallery and undo/redo support to editor canvas ([3df2dbd](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/3df2dbd8e8e98529e83d6597631b990728da2bc7))
* add tweet import, code snippet generator, and overlay resize improvements ([e64ba26](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/e64ba2653e5787984dc313e29a8c2a9ff3598ed8))
* add Umami analytics tracking for export and copy events ([f3a5ac1](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/f3a5ac1a59058cebea5c52bc33a883168c775e57))
* add video testimonials to landing page and update footer layout ([26063db](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/26063dbec57ae1cd366aa4d5da0c8e867f843e44))
* add website screenshot upload with API and UI tabs ([f454d82](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/f454d82f8fa3c7d75cc7d27278430dace09c9013))
* add X (Twitter) link to navigation ([4225490](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/4225490941d926de795523926f56389c9e2c6500))
* add X (Twitter) link to navigation ([6e1dec0](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/6e1dec0375086cddf47312efc4f4cb52e0d91404))
* autsave drafts ([94fba59](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/94fba594d367b898e9a15c9a83c1f03b9de57a55))
* autsave drafts ([4642c97](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/4642c97d7fda9e633a7612c5f5f6df41bc05f854))
* **canvas:** add undo/redo support with zundo ([6c2ab13](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/6c2ab13ad59644e9bc688f45a77a09a46e57342d))
* **canvas:** Figma-style rulers spanning the editor with selection highlight ([13b9e2b](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/13b9e2b7858f561bb07fb51ab7aca41960c8a0de))
* close the asset loop and add app-wide navigation ([#13](https://github.com/PlaybookMediaLLC/screenshot-studio/issues/13)) ([eb67f03](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/eb67f0310c51c780c66d372bf1dcbc5227e2f975))
* completed Slideshow editor + video export ([cd92356](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/cd9235663670410a11482603c428ff869d4b56b3))
* completed slideshow functionality ([f90d301](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/f90d301dff685b2ebff36df2097150249b884e02))
* customer email templating and release broadcast ([#8](https://github.com/PlaybookMediaLLC/screenshot-studio/issues/8)) ([f0409c6](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/f0409c6fa9bdc83baf6a4492cb124eb32775c8de))
* delete/backspace clears the selected main image ([947510b](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/947510bec80287d948305846f8f27cecf6d4b9c5))
* delete/backspace clears the selected main image ([da603f3](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/da603f3f9e312cf7edc08514f2fb5eb3da29cbd9))
* enable SharedArrayBuffer support with appropriate headers for multi-threaded FFmpeg WASM ([7c2a2fa](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/7c2a2fabd89c8b8d15997c57f44c62857c0dbe56))
* enhance MainImageLayer with scaling functionality and refactor transformer handling ([4b812a8](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/4b812a8d3786788474e8e930486c4408d9a96ca0))
* enhance slideshow video export functionality with improved frame handling and codec selection ([83d6970](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/83d69709420025d22ad1467d38e01c49cac1b992))
* **frames:** add glass effect to Arc frames and reduce opacity ([7b8c8d7](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/7b8c8d7fe39e9fe2962ed2bac0a358618136aba3))
* **frames:** replace old border styles with new frame types ([e547246](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/e547246679d31aece47f3304b0b85cc2bc7e1d52))
* **frames:** replace old border styles with new frame types ([ac5c8c9](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/ac5c8c9e3322f85b15521f83e52f62006d2132be))
* implement same-origin proxy for R2 assets to resolve CORS issues during video export ([e0a247f](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/e0a247f8193c800b339da647a6b09dbd42f3492a))
* increase upload limit from 10MB to 100MB ([b6112e2](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/b6112e2de3f792417313258b48ef3feed70b538e))
* make export fully in-browser and enhance canvas editor branding ([aff0ea7](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/aff0ea71d84dac17780bb8763ca29c0db7ff1e7c))
* marketing platform foundations (RFC 019, 018, 021, 012, 030) ([#5](https://github.com/PlaybookMediaLLC/screenshot-studio/issues/5)) ([44d47aa](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/44d47aa2e7fb3ba2bd02d0f72b5ed3bc62943abd))
* move frame along with the main image ([0567536](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/05675361b6c77eedc1f184d39e06cf6a94ce4213))
* NEW user-facing feature or functionality ([961dfec](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/961dfecc919fd70e67a8c9a0a638f2206f61ba43))
* NEW user-facing features only ([05d835b](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/05d835b2f4d5a083ccc31cb0c5b1e2ae8aba4941))
* optimize color conversion and video encoding processes with caching and delay handling improvements ([2ba2e98](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/2ba2e9872d323498b79128631e636e7808f30dbd))
* preload FFmpeg WASM on dialog open to improve user experience during video export ([bbcb69b](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/bbcb69b4a0a15542d2ed9332705f43089b78632e))
* save editor exports to the workspace, with tenant storage deployed ([#11](https://github.com/PlaybookMediaLLC/screenshot-studio/issues/11)) ([29a3656](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/29a3656ca7be8cca7bf7096d9a045139693d7e35))
* show saved assets in the workspace ([#12](https://github.com/PlaybookMediaLLC/screenshot-studio/issues/12)) ([46f3831](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/46f38310b7f0153c82b0591ceec3d23c63fa4b4b))
* support dark mode website screenshots ([a12af68](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/a12af6845ab2dbbd8630348f6cbdb8fd84264a1b))
* take website screenshots in dark mode ([b2c9c02](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/b2c9c02a4e084c596e14cb10da8d6f13676f0eb2))
* **ui:** refresh landing pages and editor experience ([0740e08](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/0740e087968b82580bff0005fd4dc464d1553775))
* **ui:** refresh landing pages and editor experience ([a724e0a](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/a724e0a90d590d7df8993bbe849cabeae15206a8))


### Bug Fixes

* add fallback for puppeteer launch and increase navigation timeout ([0f59164](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/0f591647c9442e6b71317d88835b6200b8fc03c3))
* adjust mockup coordinates and dimensions ([5b478fa](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/5b478faef41f01cbf830806e9b2febd24c805a47))
* apply brightness and invert filters to arrow overlays in ImageOverlayLayer and ArrowGallery ([25d4923](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/25d49232c4f69619b63be377695c294ceb00b3e1))
* **assets:** add local fallback for R2 assets with path mapping ([3d4d1c5](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/3d4d1c569a8bac94850eee7e5aaace86474a077b))
* **assets:** add local fallback for R2 assets with path mapping ([39cec92](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/39cec92416556e2fd89319288804392352eac780))
* **assets:** replace blurry abstract backgrounds with high-res versions ([2e8f8ad](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/2e8f8ad3033996099f0322ae66c6a5f0306fc574))
* **assets:** replace blurry abstract backgrounds with high-res versions ([8e7f327](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/8e7f327fb25dd68e84f64e2ee432e95e520060d9))
* browser url display, hydration error and draft persistence ([b6d76b0](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/b6d76b07bb0986394d09dc5ba85c99311e9d8008))
* browser url display, hydration error and draft persistence ([8b17b2e](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/8b17b2e29ff0fb64799e3d96e991432f7e290d0f))
* **canvas:** allow deleting overlays with Delete/Backspace keys ([fe70a68](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/fe70a6849c97b1f5faddea07cc4d9d63fb156e4b))
* **canvas:** fix background images stretch on canvas issue ([4dc3c99](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/4dc3c9929dd90ddf274f6a2bc7fa249c08bad58b))
* **canvas:** fix background images stretch on canvas issue ([97885be](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/97885be5edbb54f257b1245b3b326630e8196b62))
* **canvas:** keep main image selection handles a constant size ([57901e9](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/57901e9e5a223a55bd704ae0544de72752d7eb1e))
* **canvas:** keep main image selection handles a constant size ([cbe6d38](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/cbe6d38bf5130158d9dc442b5e23c1e0b1cf83d7))
* **ci:** generate Prisma client before trigger deploy checks ([#3](https://github.com/PlaybookMediaLLC/screenshot-studio/issues/3)) ([e510587](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/e5105872b16c70dad4fde1838d3bbc0cb9917c43))
* **ci:** give gh pr merge repository context in release-please ([#16](https://github.com/PlaybookMediaLLC/screenshot-studio/issues/16)) ([586d9f3](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/586d9f333d2d819138249d5def18fdffcbf61fb6))
* **ci:** let release-please fall back to the default token ([#14](https://github.com/PlaybookMediaLLC/screenshot-studio/issues/14)) ([2564d1d](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/2564d1dff8377ded1e760a151c2a02c3eed06aa9))
* correct demo image mapping for square images in MasonryGrid and update image list ([dc1db6d](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/dc1db6db95e7989d0ae52edbbac483e5299dbb8d))
* deleting the whole progress on hard refresh locally ([aee6965](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/aee6965dbde622ef95cf3087d078a79fac92a9d1))
* enable background blur for all background types ([c18d652](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/c18d6520cc805a2ead04a3fe27553253cd09a27e))
* enable gradient backgrounds in pure canvas implementation ([c97abb0](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/c97abb0472ac7406ee1a46a02c5b70d2defefe3b))
* ensuring background opacity is correctly applied during export, handling 0 opacity, ([7ff4cd2](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/7ff4cd2083c506a6ba155617cd0e862a0fb6e1f7))
* **frames:** prevent page reload when selecting frame type ([fdc7eba](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/fdc7eba09c1c1be293d9b121d3cef60920b7f4eb))
* **gradient-picker:** add padding to avoid cropped selection state ([a6b6376](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/a6b6376b0afd7341ef4976e466bc76939247b081))
* **gradient-picker:** add padding to avoid cropped selection state ([1e651e9](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/1e651e9ad2e4af3bd5dfd879d7c4c46fc85e9668))
* **how-it-works:** center steps layout and improve accessibility labeling ([fef9a3e](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/fef9a3e5eb2ba9e0b6ca51a00967fad2c632b22d))
* **how-it-works:** update section title ID for improved accessibility ([c614b87](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/c614b87204fd7fbb2782bdccce2d782f0133f52b))
* image resize scale desync ([13690a3](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/13690a341257336d594b7fd7b3abeafc2e41944a))
* initialize moving-border ref to null ([ac7d799](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/ac7d7997b1fc2a4dc1475f8f7db55c7514cd84a3))
* **navigation:** align editor button with other elements ([6151071](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/61510712f02e80c73b7dab087157bf5d4e945883))
* **navigation:** align editor button with other elements ([b611a4d](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/b611a4db91ded4e5f820cfbe3d551808b5ae084c))
* persist state on hard refresh ([6a922fb](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/6a922fbd28f09ae8a31ef6e31777934c52ec3dfc))
* persist state on hard refresh ([0d47917](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/0d479170ef596ba1765b46190200e6096e86607e))
* preserve shadow gradients in PNG export by disabling palette mode ([f27dca4](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/f27dca4aaa5d86a3e4299df53389c216ef1b36a7))
* resolve 3D perspective image cutoff in exports ([0e9652b](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/0e9652b3f33c643ce7750eb35797f11b00686ee1))
* resolved useAutosaveDraft build error ([49440c7](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/49440c76cf5cab7fc420b79644bb579b63df88a6))
* seo optimization ([db45e8d](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/db45e8d4139d2fbb48d4377eb629bbe611ad251c))
* set default image when switching to image background type ([473351a](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/473351a9ac01dd55779cdbd4ce879e6c896d0793))
* set export scale to 5 in useExport hook ([2f8b1e1](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/2f8b1e127d173d3a2c9bc6c447308d1a73e67442))
* slider and grab bug on the user input image ([a1971f8](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/a1971f80343f6ec5907d449cb9b035900dfbe52d))
* sync frame dimensions with image scale on transformer resize ([2edf9a5](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/2edf9a5d9d9cbfcd08f1dc3ded4425c63817071a))
* **ui:** `SliderRange` transition causing un-synchronized movement with `SliderThumb` ([3d49695](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/3d49695351d50e1cb80168d8a1d0d5530dc5dcf3))
* **ui:** SliderRange transition causing unsynchronized movement with SliderHead ([b1bb1ed](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/b1bb1edc7fe65b3143118a2481ad03f1e742c28e))
* update client ID in layout and correct script tag formatting ([d9d5125](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/d9d5125c6562a85ff4378664d790933ed53c2774))
* update export service to work with pure canvas architecture ([d9449a6](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/d9449a6bcf573ad32699fbbd312a0f25bd38246d))
* update metadata to use og.jpg instead of og.png ([734800b](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/734800ba6d88250ee25cfdd60697dc824296902a))
* use imageScale to size preset thumbnail container instead of CSS transform ([dd64ca1](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/dd64ca151744c8ee3691fe745b85943791617b5c))
* use imageScale to size preset thumbnail container instead of CSS… ([8a6856c](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/8a6856c588eb35ec8386f5866253e6af7297f3f9))


### Performance Improvements

* scope store subscriptions to prevent panel re-renders on resize ([9920931](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/99209313d58acc406d8a32cbafe5a400f19f642a))
* scope store subscriptions to prevent panel re-renders on resize ([ee75fe9](https://github.com/PlaybookMediaLLC/screenshot-studio/commit/ee75fe992e7e69c727be60fff73c00c524bd168c))
