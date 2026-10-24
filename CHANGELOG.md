# Changelog

## [0.6.0](https://github.com/frontierdsgn/werft/compare/v0.5.0...v0.6.0) (2026-10-24)


### ⚠ BREAKING CHANGES

* werft no longer supports Node 20; sites and build hosts need Node 22 or newer. (Cloudflare Pages builds already use `NODE_VERSION=22` per the README.)

### Features

* a page with the slug 404 is the site's not-found page ([#75](https://github.com/frontierdsgn/werft/issues/75)) ([ef122a0](https://github.com/frontierdsgn/werft/commit/ef122a0af7d8d11bafd96878acc94a89f4ebcaf4))
* **admin:** "Mein Konto": every role changes its own name and password ([#86](https://github.com/frontierdsgn/werft/issues/86)) ([afa6b04](https://github.com/frontierdsgn/werft/commit/afa6b04cae7ef5acbc64e41fb589671363cbe840))
* **admin:** change a page's address, with a redirect from the old one ([#66](https://github.com/frontierdsgn/werft/issues/66)) ([d7050fc](https://github.com/frontierdsgn/werft/commit/d7050fc30736f25b334992326058e8ed86b1e0b0))
* **admin:** duplicate a page ([#74](https://github.com/frontierdsgn/werft/issues/74)) ([e1d89e3](https://github.com/frontierdsgn/werft/commit/e1d89e3eb3670d68879b8da962590ebaaf2c4e3a))
* **admin:** keep unsaved changes across a closed tab or a crash ([#73](https://github.com/frontierdsgn/werft/issues/73)) ([e3630de](https://github.com/frontierdsgn/werft/commit/e3630de84469da9901dd3db1d2e510e242ee83a2))
* **admin:** restore deleted pages and entries ([#80](https://github.com/frontierdsgn/werft/issues/80)) ([11d8603](https://github.com/frontierdsgn/werft/commit/11d8603f802b6823a1355f1d9ac82c18a19f6442))
* **admin:** search in the sidebar ([#84](https://github.com/frontierdsgn/werft/issues/84)) ([727edb6](https://github.com/frontierdsgn/werft/commit/727edb6dd9ec63caa19864f4714294e34ef1942c))
* **check:** werft check for broken links, missing media, alt texts and large files ([#70](https://github.com/frontierdsgn/werft/issues/70)) ([a7f22e9](https://github.com/frontierdsgn/werft/commit/a7f22e908fa5642405c320019cb09fb4ba87fe62))
* **cloudflare:** scheduled publishing starts the site's deploy workflow ([#94](https://github.com/frontierdsgn/werft/issues/94)) ([c43c686](https://github.com/frontierdsgn/werft/commit/c43c6863769aa12d751e5f3fe6700fb61909f30f))
* **editor:** scale large uploads down before they are saved ([#71](https://github.com/frontierdsgn/werft/issues/71)) ([26a7f33](https://github.com/frontierdsgn/werft/commit/26a7f33f6ef33f2f68d4cd8244903e1126945bb6))
* **forms:** e-mail a new submission, and confirm it to the visitor ([#72](https://github.com/frontierdsgn/werft/issues/72)) ([99deca5](https://github.com/frontierdsgn/werft/commit/99deca51ff2de64af60a631a7d658c48a0344361))
* **forms:** thank-you page and confirmation in the visitor's language ([#78](https://github.com/frontierdsgn/werft/issues/78)) ([ec1f409](https://github.com/frontierdsgn/werft/commit/ec1f4096a182fcdff24271e101162d4b7e29ee44))
* **gateway:** e-mail interface with memory and log drivers ([#64](https://github.com/frontierdsgn/werft/issues/64)) ([0970c84](https://github.com/frontierdsgn/werft/commit/0970c84d1fa74d9954d6abfd65ff6acfb1981386))
* **gateway:** mail drivers for Cloudflare Email Service, Brevo, Resend and SMTP ([#76](https://github.com/frontierdsgn/werft/issues/76)) ([4ae78c8](https://github.com/frontierdsgn/werft/commit/4ae78c817b15c4109b7df22211c0b5b3983aa5e5))
* **gateway:** optional two-factor sign-in with an authenticator app ([#93](https://github.com/frontierdsgn/werft/issues/93)) ([7201943](https://github.com/frontierdsgn/werft/commit/7201943c5e978e7435ce4d7b3e09725a060b8ad5))
* **gateway:** reset a forgotten password by e-mail ([#90](https://github.com/frontierdsgn/werft/issues/90)) ([9d33867](https://github.com/frontierdsgn/werft/commit/9d338670ab91103dc1364487c352b93ab3a6dc03))
* **gateway:** shareable preview links for drafts ([#92](https://github.com/frontierdsgn/werft/issues/92)) ([c04dc7d](https://github.com/frontierdsgn/werft/commit/c04dc7d751faa894e2e6ec7b5352e145d4087a5a))
* **gateway:** sign-out ends the session on the server ([#81](https://github.com/frontierdsgn/werft/issues/81)) ([6110132](https://github.com/frontierdsgn/werft/commit/61101321414f3dcd9dd68604e5349bdc455c0046))
* **gateway:** throttle failed sign-ins ([#69](https://github.com/frontierdsgn/werft/issues/69)) ([8b04f5c](https://github.com/frontierdsgn/werft/commit/8b04f5cad14f6c3281ceb26c63d08f3522bc1df9))
* **images:** responsive images with sizes made by the Node build ([#77](https://github.com/frontierdsgn/werft/issues/77)) ([93a1d7d](https://github.com/frontierdsgn/werft/commit/93a1d7d2cd2510465d592e1bbbfe35b2a105268a))
* **media:** search the library, replace an image everywhere, focal point, alt text hint ([#88](https://github.com/frontierdsgn/werft/issues/88)) ([b3e6556](https://github.com/frontierdsgn/werft/commit/b3e6556e54b29030e76c096fdc5721bd300d2172))
* site search with an index per language ([#68](https://github.com/frontierdsgn/werft/issues/68)) ([a65a227](https://github.com/frontierdsgn/werft/commit/a65a227dd5438fc6fcf9c29030825524122bfd6e))
* sites in several languages ([#24](https://github.com/frontierdsgn/werft/issues/24)) ([6319146](https://github.com/frontierdsgn/werft/commit/63191462aef3be18041d782ffe5ca54572230057))
* **theme:** ctx.asset() for theme stylesheets and scripts with a content hash ([#79](https://github.com/frontierdsgn/werft/issues/79)) ([9699ff0](https://github.com/frontierdsgn/werft/commit/9699ff0dfeb42d4fc054eea1dc6dde3fc779c680))
* **theme:** ctx.head() for title, canonical address and link previews ([#65](https://github.com/frontierdsgn/werft/issues/65)) ([2b3a946](https://github.com/frontierdsgn/werft/commit/2b3a94691777ef57c3d60178860baf47188737e4))
* **theme:** RSS feed of the newest posts, linked by ctx.head() ([#87](https://github.com/frontierdsgn/werft/issues/87)) ([27c9377](https://github.com/frontierdsgn/werft/commit/27c9377606585c763cbfcc328053ed617bdcf5d5))
* **theme:** site icon in the settings, written by ctx.head() ([#82](https://github.com/frontierdsgn/werft/issues/82)) ([1098a49](https://github.com/frontierdsgn/werft/commit/1098a493d1ba6d161e69e4ba351ca1285f3d34de))
* **theme:** structured data from the site settings ([#91](https://github.com/frontierdsgn/werft/issues/91)) ([41a3d11](https://github.com/frontierdsgn/werft/commit/41a3d11ec52bd8a57752f12f5d6b79ee4d305d71))
* **update-sites:** open a pull request per site and merge it on a green gate ([#23](https://github.com/frontierdsgn/werft/issues/23)) ([7430910](https://github.com/frontierdsgn/werft/commit/74309107d19417e78abaca2f0dac8b30deb837c2))
* **update-sites:** run the site's gate before pushing ([#20](https://github.com/frontierdsgn/werft/issues/20)) ([035ca3d](https://github.com/frontierdsgn/werft/commit/035ca3d664f0e4265c26a11c66651b3885f20cae))


### Bug Fixes

* **hooks:** run the pre-push gate without the hook's git environment ([#63](https://github.com/frontierdsgn/werft/issues/63)) ([2fa000d](https://github.com/frontierdsgn/werft/commit/2fa000db0e19450a5b4bd475b0b451cbbfda4a0c))


### Build System

* require Node 22 or newer ([#6](https://github.com/frontierdsgn/werft/issues/6)) ([dfd79f7](https://github.com/frontierdsgn/werft/commit/dfd79f76ca60bac60d24dc27a31cfa846bcc9a70))

## Changelog
