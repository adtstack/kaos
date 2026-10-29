# 입력 중 과거 내용으로 되돌아가는 증상 관측

작성일: 2026-09-30. 사용자 보고: **입력 중에도 곧바로 과거 내용으로 돌아감**.
이벤트 중복은 주된 가설에서 제외한다. 실제 원인은 아직 미확정이다.

## 수집할 증거

Flight taxonomy 12의 `editor.causality.observed`는 열린 편집기의 상태를
다음 지점에서 수집한다. 본문은 이벤트에 넣지 않고 비동기로 지문화한다.

| phase / 이벤트 | 기록하는 근거 |
|---|---|
| `trace-start` | 수집을 시작할 때 이미 열린 각 pane의 편집기·CRDT 기준 상태 |
| `crdt-change` | CRDT 변경 직후의 CRDT, 당시 편집기, transaction origin, 삽입·삭제 길이, 증가한 CRDT client clock |
| `editor-update` | 편집기 변경 전후, CRDT, 사용자/비사용자 변경 여부, Undo/Redo, IME 상태 |
| `binding-applied` | bind/repair 전후 편집기, 선택된 Y.Text identity, 바인딩 사유 |
| `symptom-marked` | 사용자가 되돌림을 보았다고 표시한 시점의 각 pane |
| `disk.modify.classified` | 정확한 디스크 revision의 자기쓰기 판정, 원문/편집기 정규화 내용 지문, 당시 runtime 유효성 |
| `disk.write.ok` | KAOS가 쓰기를 성공적으로 정산한 내용 지문 |
| `disk.write.committed` | Vault.process/create가 반환한 직후의 내용 지문. 후속 검증·정산 성공과 구분 |

각 편집기 이벤트에는 `cmId`, 익명 pane identity인 `paneId`, `bindingEpoch`, `yTextId`,
`editorRevision`, `editorAuthorityRevision`, `yTextRevision`,
`connectionGeneration`, 연결/초기 동기화/로컬 캐시 준비 여부가 있다.
`runtimeId`로 같은 추적 중 동기화 runtime이 재생성된 경계도 구분한다.
`advancedClients`는 CRDT client clock이며 서버 전달자나 사람의 신원은 아니다.
삭제만 있는 transaction은 증가한 client clock이 없을 수도 있다.

`originKind`는 `provider`, `persistence`, `local-repair`, `editor-binding`,
`undo-manager`, `unspecified`, `other`로 구분한다. `originName`에는 등록된
KAOS origin 상수만 허용한다. 임의 origin 객체/문자열은 직렬화하지 않는다.

## 실제 기기에서 수집

1. 관측 코드가 포함된 **같은 main.js와 telemetry.js**를 관련 기기에 설치한다.
   버전 문자열만 같다고 같은 번들인 것은 아니다. 이 작업에서는 실제 기기에
   설치하거나 실행하지 않았다.
2. KAOS Advanced의 **Debug logging**을 켜고, 진단 명령이 없으면 플러그인을
   다시 로드한다. **Flight recorder mode**는 `Safe (redacted)`로 둔다.
   이 준비를 마친 뒤 발생하는 증상을 수집한다.
3. 관련 기기 각각에서 `Start telemetry trace`와 `Show device identity`를 실행한다.
   같은 물리 폴더를 관측하는 Obsidian/headless 인스턴스가 있는지도 기록한다.
4. 증상 파일에서 입력하며 관측한다. 되돌림을 보는 즉시 `Mark editor rollback`을
   실행한다. 이 명령은 파일이나 CRDT를 수정하지 않는다. pane 수가 0이면
   바인딩된 편집기 증거가 없으므로 정상적인 표식 수집으로 간주하지 않는다.
5. **추적을 종료하기 전에** `Export safe telemetry trace`를 실행한다.
   출력 NDJSON의 경로가 알림에 나온다. 필요하면 `Export safe witness bundle`도
   실행하고 콘솔의 번들을 별도로 보관한다. 분석기의 입력은 **flight trace**다.
6. 내보내기가 성공한 다음 `Stop telemetry trace`를 실행한다.
   발생 시각, 다른 기기의 편집 여부, 재연결 여부, 상대 기기의 실행 여부를 함께 기록한다.

리셋·강제 복구로 상태를 바꾸기 전에 원래 증상의 추적을 내보낸다.
Dashboard Recent activity는 실시간 처리 순서의 증거로 쓰지 않는다.

기본 Safe 모드의 지문은 추적별 비밀로 만들어지므로 서로 다른 추적/기기의
지문을 직접 비교할 수 없다. 교차 기기 비교가 필요하면 기존
`Shared-secret safe` 모드와 같은 trace secret을 사용한다. secret 자체는
로그/공유 자료에 넣지 않는다. 분석기는 어느 경우에도 기기 간 `seq`나
벽시계를 합쳐 인과 순서로 해석하지 않는다.

## 관측 결과별 확인

```bash
npm run qa:analyze-editor-causality -- device-a.ndjson device-b.ndjson --out report.json
```

| 결과 | 다음으로 확인할 근거 | 판정 한계 |
|---|---|---|
| `editor-crdt-diverged-after-input` | 입력 직후 편집기와 CRDT 불일치, binding health, 배치 transaction/IME | 입력 전파 누락의 단서. 단일 시점 불일치만으로 손실 확정 불가 |
| `non-user-return-to-seen-editor-state` + `provider-crdt-projection` 후보 | 해당 CRDT 변경의 client clock·삭제/삽입 크기와 상대 기기 로그 | 원격 경로에서 과거 내용이 새 수정으로 재작성됐는지 확인. provider가 원본 작성자를 뜻하지 않음 |
| 같은 결과 + `local-repair-crdt-projection` 후보 | `originName`, 인접 `recovery.decision/apply.*`, editor shield | 로컬 복구가 선택한 source와 상태 fence 확인 |
| 같은 결과 + `disk-reload:*` 후보 | 디스크 지문·revision, 자기쓰기 판정, reload bypass | 내용 일치 후보이며 실제 작성 프로세스 확정 불가 |
| 같은 결과 + `binding-reprojection` 후보 | bind/repair 사유, 바인딩 epoch·Y.Text identity 변화 | 바인딩을 다시 붙이는 순간 과거 CRDT가 표시됐는지 확인 |
| `repeated-same-content-disk-write` | `disk.write.committed`의 실제 시각 간격과 해당 경로의 디스크 관측 | 같은 내용 쓰기 반복이며 내용 되돌림과 별개일 수 있음. committed가 없는 구형 로그는 ok 기준 |
| `user-reported-rollback`만 있음 | 표식 직전 timeline, 수집이 시작되기 전의 과거 상태, 누락 상태 | 과거 내용이 수집 시작 전에 생겼으면 지문 재등장은 자동 검출할 수 없음 |
| `INSUFFICIENT_EVIDENCE` | 누락·redaction·hash 실패·지원하지 않는 구형 로그 | 원인 판정을 보류하고 수집 조건을 고쳐 다시 관측 |

`candidates`는 최근 같은 경로의 관측에서 지문이 일치한 **후보**다.
원인 확정이나 자동 수정 승인이 아니다. 의도적인 Undo/Redo는 되돌림 의심
결과에서 제외한다. 동일 pane의 과거 상태 이력은 최근 64개 지문으로 제한된다.
지문 재등장이 없다는 결과도 증상이 없다는 증명은 아니다.
비동기 디스크 판정이 편집기 이벤트보다 늦게 기록되면 후보 자동 분류에
잡히지 않을 수 있다. 이 경우 `disk.modify.observed`와 classified의 `opId`,
`eventObservedAt`, revision을 직접 대조한다.

## 지문·순서·수집 한계

- 지문은 비밀 + 전용 domain + 정확한 문자열의 SHA-256이다. 본문과 비밀은
  저장하지 않는다. `diskEditorNormalizedHash`만 BOM 제거와 개행 정규화를 거친다.
  원문 디스크 지문도 함께 남겨 정규화 차이를 되돌림으로 오판하지 않는다.
- `seq`는 해시 계산 전에 예약한다. 저장 줄의 순서는 비동기 완료 순서일 수
  있으므로 기기/boot/trace 내부에서 `seq`로 정렬한다. `observedAt`과
  `observedMono`는 캡처 시점이고 envelope `ts`는 기록 완료 시점이다.
- stop/export는 진행 중인 지문화와 경로 익명화 작업을 기다린다.
  비정상 종료 직전의 미완료 로그까지 영속화됐다고 보장하지 않는다.
- 동시 지문화는 64개, 보유 샘플 합은 4,000,000 UTF-16 문자로 제한한다.
  한도를 넘으면 `captureStatus: capacity-exceeded`, 암호 기능 실패 시
  `hash-unavailable`, 샘플을 읽지 못하면 `snapshot-unavailable`을 기록한다.
  recorder 누락/익명화 실패도 분석기의 evidence gap에 포함한다.
- 로그는 추적이 켜졌을 때만 수집한다. 추적 이전 상태, 다른 앱/프로세스의
  내부 동작, 네트워크 송신·서버 영속화는 이 관측만으로 입증하지 않는다.

## 검증 기록

| 검증 | 상태 |
|---|---|
| 실제 Y.Doc/CodeMirror transaction으로 origin·입력 불일치·과거 지문 재등장 분류 | PASS |
| 관측이 editor/CRDT를 변경하지 않음, 본문·파일명 미노출 | PASS |
| 지문화 순서 예약, 용량 한도 표식, stop/export의 미완료 작업 배출 | PASS |
| 의도적 Undo 제외, 다른 기기/runtime 이력 혼합 방지, 증거 부족 판정 | PASS |
| 분석 CLI 실행 및 잘못된 NDJSON 거부 | PASS |
| 전체 회귀 | PASS — 186 suites, 0 failures |
| 최종 build | PASS — TypeScript 및 production bundle |
| 관측 모듈 ESLint | PASS — main.ts를 제외한 수정 관측 모듈에 오류 없음 |
| main.ts 포함 ESLint | FAIL — 기존 UI 문구/console 규칙 위반 6개; 해당 코드는 이번 관측 변경 전에도 존재 |
| 실제 Obsidian 기기에서 사용자 증상과 원인 연결 | NOT_RUN |

테스트: `tests/editor-causality.ts`. 검증 통과는 실제 증상의 원인 확정이 아니다.

전체 회귀는 외부 실행 설정이 테스트의 임시 vault에 섞이지 않도록
`KAOS_PLUGIN_DIR`, `KAOS_PLUGIN_ID`, `KAOS_HOST`, `KAOS_VAULT_ID`,
`KAOS_DEVICE_NAME`, `KAOS_SYNC_TOKEN`, `SYNC_TOKEN`,
`KAOS_ENABLE_ATTACHMENT_SYNC`를 해당 테스트 프로세스에서만 제외하고 실행했다.
사용자의 실행 환경이나 설정 파일은 변경하지 않았다.
