# Headless Host Core API Surface

작성일: 2026-07-08

상태: L1 readiness 기준. 범용 Obsidian runtime 제품 선언이 아니다.

이 문서는 `src/headless-host/core/*`가 제공하는 Obsidian-like host surface를
정리한다. 목적은 KAOS L0 안정성을 유지하면서, 나중에 filesystem-only 단일
플러그인 host로 확장 가능한 경계를 눈에 보이게 두는 것이다.

## 호환성 레벨

```text
L0: KAOS private headless host
L1: filesystem-only single plugin host readiness
L2: multi-plugin host 후보
L3: broad Obsidian-compatible runtime 후보
```

현재 구현은 L0 제품 + L1 readiness smoke다. L2/L3는 제품 범위가 아니다.

## Core Surface

| Area | 구현 | L1 readiness 의미 | 제한 |
| --- | --- | --- | --- |
| App | `HeadlessApp` | vault/workspace/metadataCache/fileManager/plugins를 제공 | 실제 Obsidian UI app이 아님 |
| Vault | `HeadlessVault` | text/binary create/read/modify/delete/rename/trash, folder, events | 파일시스템 기반, editor authority 없음 |
| Adapter | `HeadlessVaultAdapter` | read/write/stat/list/exists/mkdir/remove/rename/rmdir | vault-relative path guard 필수 |
| File types | `TFile`, `TFolder`, `TAbstractFile` | `instanceof TFile` checks 지원 | Obsidian 전체 file model 아님 |
| Plugin lifecycle | `Plugin`, `Component` | `onload`, `unload`, cleanup, child component cleanup | UI lifecycle 일부만 |
| Plugin boot | `bootHeadlessPlugin`, `unloadHeadlessPlugin` | KAOS가 아닌 단일 plugin도 부팅 가능 | multi-plugin manifest scan/load order 없음 |
| Plugin data | `HeadlessPluginStorage` + `HeadlessApp.pluginStorageFor()` | single-file 또는 per-plugin-file storage | L2 registry persistence 아님 |
| Plugin registry | `HeadlessPluginRegistry` | `plugins[id]`, enabled set, register/unregister | dependency/load order 없음 |
| Workspace | `HeadlessWorkspace` | no-open-editor workspace, layout ready callbacks | editor/view/leaf 실구현 없음 |
| Metadata cache | `HeadlessMetadataCache` | minimal `getFirstLinkpathDest()` file lookup | full markdown parse/cache 없음 |
| File manager | `HeadlessFileManager` | trash/rename delegating to vault | Obsidian UI prompts 없음 |
| requestUrl | `requestUrl` | fetch wrapper with text/json/arrayBuffer result | Obsidian requestUrl 전체 옵션 아님 |
| Strict compat | `strictCompat.ts` | unsupported API를 조용히 삼키지 않기 위한 trap | 모든 미지원 API가 아직 나열된 것은 아님 |

## 검증

현재 L1 readiness는 다음 테스트로 검증한다.

```bash
node --import jiti/register tests/headless-host-l1-plugin-host.ts
node --import jiti/register tests/headless-host-core-boundary.ts
node tests/run-regressions.mjs --only headless-host
```

`tests/headless-host-l1-plugin-host.ts`는 KAOS를 import하지 않는 fixture plugin으로
다음을 검증한다.

- generic boot/unload helper
- single-file plugin data
- per-plugin-file storage namespace
- registry register/unregister
- vault text/binary APIs
- vault event cleanup
- command/settings/view/protocol/editor extension unload cleanup
- requestUrl JSON handling
- metadata cache linkpath resolution

## KAOS Runner Loading

KAOS headless 제품 경로는 runner와 플러그인을 분리한다.

- runner: `/opt/kaos/kaos-headless-host.mjs` 같은 독립 실행 파일
- plugin: 지정된 vault 안의 `.obsidian/plugins/kaos/{manifest.json,main.js,...}`
- 기본 CLI 해석: `--vault /srv/kaos/vault`이면
  `/srv/kaos/vault/.obsidian/plugins/kaos`를 로드
- override: `--plugin-id` 또는 `--plugin-dir`

즉 headless 업데이트는 runner/helper 업데이트이고, KAOS 플러그인 업데이트는
vault 안의 Obsidian 플러그인 업데이트다. 이 구조는 실제 Obsidian에서 쓰는
플러그인 artifact를 headless가 그대로 읽게 하므로, 플러그인 수정/배포와
headless runner 배포를 강제로 묶지 않는다.

## 아직 범위 밖

- 여러 community plugin을 동시에 로드하는 제품 기능
- `.obsidian/plugins/*/manifest.json` 전체 scan
- plugin dependency/load order
- Modal, ItemView, WorkspaceLeaf, MarkdownView 등 UI surface
- 실제 CodeMirror/editor compatibility
- 범용 CLI 또는 npm package 공개

## 판단

`core/`는 이제 KAOS 없이도 filesystem-only 단일 플러그인 smoke를 통과한다. 이것은
L1 제품 선언이 아니라 L1 readiness 증거다. 다음에 L2 이상을 검토하려면 이 표의
제한 항목을 하나씩 명시적으로 설계하고 테스트해야 한다.
