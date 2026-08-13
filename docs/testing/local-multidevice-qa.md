# Local Multi-Device QA

이 문서는 KAOS를 Cloudflare에 배포하지 않고 로컬 Worker와 격리된 테스트
vault로 검증하는 공식 절차다. 로컬 다중 단말 QA의 기준 문서는 이 파일 하나로
유지한다. 명령, 기대 결과 또는 알려진 실패가 바뀌면 구현과 함께 이 문서를
갱신한다.

## 1. 범위

이 절차로 검증하는 것:

- Markdown 생성, 수정, 삭제와 WebSocket 동기화
- 오프라인 후 재접속과 두 장치 수렴
- 열린 편집기의 원격 수정
- 다른 프로그램이 vault 파일을 수정했을 때의 가져오기와 충돌 보존
- 로컬 Worker의 인증 ticket과 Durable Object 상태
- QA trace, manifest, analyzer 결과 수집

이 절차의 기본 구성에서는 검증하지 않는 것:

- R2가 필요한 첨부파일 및 snapshot/recovery snapshot
- 실제 Cloudflare 배포, DNS, Access 또는 운영 환경의 TLS
- 모바일 백그라운드 동작의 자동화

Wrangler/workerd는 로컬 실행 도구로 사용하지만 Cloudflare 계정, 로그인, 배포는
필요하지 않다.

## 2. 안전 규칙

1. 실제 vault나 실제 sync ID를 사용하지 않는다.
2. `qa:prepare --clean`은 이 절차를 위해 만든 전용 경로에만 사용한다.
3. 모든 장치는 같은 `vaultId`와 token을 사용하고, `deviceName`은 서로 다르게
   설정한다.
4. QA product build와 `kaos-qa-harness`는 실제 vault에 설치하지 않는다.
5. LAN의 평문 HTTP는 격리된 신뢰 네트워크에서만 사용한다. token이 암호화되지
   않은 채 전송된다.
6. 한 번의 검증 중에는 commit, plugin bundle, Worker 코드와 persistence 경로를
   바꾸지 않는다.

## 3. 지원 토폴로지

| 구성 | Server URL | 자동화 | 비고 |
|---|---|---|---|
| 한 컴퓨터의 Obsidian 두 개 | `http://127.0.0.1:8787` | CDP controller 지원 | 권장, 가장 재현 가능 |
| 같은 LAN의 다른 컴퓨터/모바일 | `http://HOST_LAN_IP:8787` | 수동 | Worker를 `0.0.0.0`에 bind해야 함 |
| 신뢰할 수 없는 네트워크 | HTTPS origin | 환경별 | 이 문서의 평문 LAN 절차를 사용하지 않음 |

KAOS setup link는 보안상 localhost가 아닌 HTTP origin을 거부한다. 따라서 LAN
HTTP 테스트에서는 setup link나 QR 설정을 사용하지 말고 KAOS 설정의
`Manual connection`에서 값을 직접 입력한다. 수동 입력 경로는 경고 후 연결을
허용한다.

모바일 OS 또는 네트워크 정책이 평문 HTTP/WebSocket을 차단할 수 있다. 코드상
수동 LAN HTTP는 허용되지만, 실기기에서 연결되지 않으면 먼저 브라우저의
capabilities 접근과 방화벽을 확인하고 필요하면 신뢰된 HTTPS endpoint를
준비한다.

## 4. 준비물과 실행 신원 기록

정확한 macOS 명령을 기준으로 작성했다. Linux와 Windows에서는 Obsidian 실행
경로만 해당 플랫폼에 맞게 바꾼다.

- Node.js 20 (CI 기준 버전)
- npm
- Bun
- Obsidian Desktop
- 물리 단말 테스트 시 같은 LAN과 해당 단말의 Obsidian

저장소 root에서 실행한다.

```bash
git status --short --branch
git rev-parse HEAD
node --version
bun --version
npm ci
npm ci --prefix server
```

검증 결과에는 최소한 commit SHA, working tree 상태, plugin version, Obsidian
version과 각 장치 이름을 함께 남긴다. 재개발 기준점인 v1.10.3 commit은
`6e550b2ddcdc9bd5ef55fb563f4815ece1a4df54`이다. 실제 검증 결과에는 이 기준점이
아니라 테스트한 branch의 정확한 `git rev-parse HEAD`를 기록한다.

## 5. 자동 회귀 테스트

실제 Obsidian을 열기 전에 코드와 로컬 Worker 회귀를 먼저 실행한다.

최소 gate:

```bash
npm run lint
npm run build
npm run test:ci:release
npm --prefix server run typecheck
```

현재 GitHub CI의 기능 검증과 같은 범위까지 실행하려면 다음 항목도 포함한다.

```bash
npm run build:headless:host
npm run prepare:headless-host-oracle-upload
npm run test:coverage:critical
npm run test:integration:headless-host
```

이 테스트들은 Cloudflare 계정이나 배포를 요구하지 않는다. `npm audit`은 package
registry 네트워크가 필요한 공급망 점검이므로 기능 테스트와 별도로 실행한다.

## 6. 로컬 Worker 실행

아래 token은 QA 전용 예시다. 운영 token으로 재사용하지 않는다. persistence
경로도 실행마다 새 suffix를 사용한다.

### 6.1 같은 컴퓨터에서만 연결

별도 터미널에서:

```bash
npm --prefix server run dev -- \
  --ip 127.0.0.1 \
  --port 8787 \
  --persist-to /tmp/kaos-wrangler-qa-v1103-run1 \
  --var SYNC_TOKEN:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
```

### 6.2 같은 LAN의 다른 단말도 연결

위 명령 대신 모든 인터페이스에 bind한다.

```bash
npm --prefix server run dev -- \
  --ip 0.0.0.0 \
  --port 8787 \
  --persist-to /tmp/kaos-wrangler-qa-v1103-run1 \
  --var SYNC_TOKEN:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
```

호스트 컴퓨터에서 확인:

```bash
curl --fail --silent --show-error http://127.0.0.1:8787/api/capabilities
```

다른 단말에서는 브라우저로
`http://HOST_LAN_IP:8787/api/capabilities`를 연다. JSON 응답을 받지 못하면
KAOS를 설정하기 전에 IP, OS 방화벽, Wi-Fi client isolation과 포트 8787을
확인한다.

기본 로컬 Worker에는 `KAOS_BUCKET` R2 binding이 없다. Settings에 attachments나
snapshots가 unavailable로 표시되는 것은 정상이다.

## 7. 두 개의 데스크톱 QA vault 준비

QA bundle을 먼저 만든다.

```bash
npm run build
npm run build:qa-product
npm run build:harness
```

그 다음 서로 다른 전용 vault를 준비한다. 다음 두 경로 외의 데이터를 지우지
않도록 주의한다.

```bash
npm run qa:prepare -- --fixture 001-basic-markdown --dest /tmp/kaos-qa-a --clean
npm run qa:prepare -- --fixture 001-basic-markdown --dest /tmp/kaos-qa-b --clean
```

`qa:prepare`는 두 vault에 각각 다른 임시 `vaultId`를 만든다. 연결 전에 한쪽 ID로
반드시 통일해야 한다.

소스를 변경한 뒤에는 Obsidian을 종료하고 build 세 개와 `qa:prepare`를 다시
실행한다. 새 bundle을 build하는 것만으로는 이미 준비된 vault의 plugin 파일이
교체되지 않는다.

## 8. Obsidian 두 개 실행

각 명령을 별도 터미널에서 실행한다. 서로 다른 CDP port와 `user-data-dir`이
필수다.

장치 A:

```bash
/Applications/Obsidian.app/Contents/MacOS/Obsidian \
  --remote-debugging-port=9222 \
  --user-data-dir=/tmp/kaos-obsidian-a \
  /tmp/kaos-qa-a
```

장치 B:

```bash
/Applications/Obsidian.app/Contents/MacOS/Obsidian \
  --remote-debugging-port=9223 \
  --user-data-dir=/tmp/kaos-obsidian-b \
  /tmp/kaos-qa-b
```

각 인스턴스에서 community plugins를 허용하고 `KAOS`와 `KAOS QA Harness`가 모두
활성화됐는지 확인한다.

## 9. 연결 설정

두 인스턴스의 `Settings → KAOS`에서 다음 값을 설정한다.

| 항목 | 장치 A | 장치 B |
|---|---|---|
| Server URL | `http://127.0.0.1:8787` | `http://127.0.0.1:8787` |
| Sync token | 6절의 QA token | 같은 token |
| Vault ID | A에 생성된 값 | A와 정확히 같은 값 |
| Device name | `qa-device-a` | `qa-device-b` |

외부 프로그램 수정은 사용자 선택 설정이 아니다. 현재 고정 동작은
`include-open-files-safely`다. 닫힌 파일은 정상 입력으로 가져오고, 열린 파일은
durable baseline을 사용해 비중첩 변경만 병합한다. 중첩·baseline 누락·authority
모호성은 열린 editor를 primary로 유지하고 외부 원문 전체를 local-only conflict
artifact에 보존한다.

LAN의 실제 다른 단말에서는 `127.0.0.1` 대신
`http://HOST_LAN_IP:8787`을 수동 입력한다. `127.0.0.1`은 각 단말 자기 자신을
뜻하므로 공유할 수 없다.

설정 후 두 장치에서 KAOS를 한 번 disable/enable하거나 Obsidian을 다시 시작한다.
Dashboard에서 두 장치 모두 연결됐고 같은 vault를 보고 있는지 확인한 뒤
테스트한다.

## 10. Harness 준비 확인

각 데스크톱 인스턴스에 대해 liveness smoke를 실행한다.

```bash
QA_CDP_PORT=9222 QA_VAULT_PATH=/tmp/kaos-qa-a node qa/controllers/run-smoke-ready.mjs
QA_CDP_PORT=9223 QA_VAULT_PATH=/tmp/kaos-qa-b node qa/controllers/run-smoke-ready.mjs
```

두 명령 모두 PASS여야 다중 장치 시나리오 결과가 의미가 있다. 실패하면 제품
plugin, QA product build, harness, `qaDebugMode`, community plugin 순서부터
확인한다.

## 11. 권장 두 장치 검증 순서

각 시나리오는 개별 실행하고 생성된 `qa-runs/` 디렉터리를 보존한다. 앞 단계가
실패하면 뒤 단계를 통과시키기 위해 상태나 기대값을 바꾸지 말고 새 persistence
경로와 새 QA vault로 원인을 분리한다.

### 11.1 실제 편집 전파

```bash
npm run qa:two-device -- \
  --scenario s12a-with-edit \
  --port-a 9222 --port-b 9223 \
  --vault-a /tmp/kaos-qa-a --vault-b /tmp/kaos-qa-b \
  --out-dir qa-runs
```

### 11.2 오프라인 handoff

```bash
npm run qa:two-device -- \
  --scenario offline-handoff-create \
  --port-a 9222 --port-b 9223 \
  --vault-a /tmp/kaos-qa-a --vault-b /tmp/kaos-qa-b \
  --out-dir qa-runs
```

### 11.3 삭제가 되살아나지 않는지 확인

```bash
npm run qa:two-device -- \
  --scenario delete-does-not-resurrect \
  --port-a 9222 --port-b 9223 \
  --vault-a /tmp/kaos-qa-a --vault-b /tmp/kaos-qa-b \
  --out-dir qa-runs
```

### 11.4 열린 편집기의 원격 수정

```bash
npm run qa:two-device -- \
  --scenario s13-editor-open-remote-edit \
  --port-a 9222 --port-b 9223 \
  --vault-a /tmp/kaos-qa-a --vault-b /tmp/kaos-qa-b \
  --out-dir qa-runs
```

### 11.5 닫힌 파일의 양쪽 변경과 충돌 artifact

```bash
npm run qa:two-device -- \
  --scenario s12c-conflict \
  --port-a 9222 --port-b 9223 \
  --vault-a /tmp/kaos-qa-a --vault-b /tmp/kaos-qa-b \
  --out-dir qa-runs
```

이 시나리오의 정상 결과는 B의 disk 내용이 원래 경로에 남고, 원격 CRDT 내용은
B의 로컬 conflict artifact에 보존되며 그 artifact가 A로 동기화되지 않는 것이다.

전체 controller 시나리오 목록은
[`qa/controllers/two-device.ts`](../../qa/controllers/two-device.ts)의
`TWO_DEVICE_SCENARIOS`가 기준이다. 장시간/진단 시나리오는 위 최소 순서가 통과한
뒤 하나씩 실행한다.

## 12. 외부 프로그램 수정 검증

이 절의 “외부 프로그램”은 VS Code, shell, git checkout, agent처럼 vault의 실제
파일 bytes를 바꾸는 프로그램을 뜻한다. Obsidian editor API를 통한 수정은 여기에
포함되지 않는다. 테스트 전에 대상 파일의 editor, disk, CRDT가 같은 baseline인지
확인한다.

### 12.1 닫힌 파일

1. A에서 `QA-scratch/external-closed.md`를 만들고 두 장치에 수렴시킨다.
2. B에서 해당 note의 모든 pane을 닫는다.
3. VS Code, shell editor 또는 파일 관리 앱으로 B의 파일에 고유 marker를 추가한다.
4. B가 변경을 가져오고 A에도 동일 marker가 한 번만 나타나는지 확인한다.
5. A와 B의 최종 bytes가 같고 conflict artifact가 불필요하게 생성되지 않았는지
   확인한다.

기대 결과: 닫힌 파일의 외부 수정은 정상 입력으로 가져와 동기화한다.

### 12.2 열린 파일의 비중첩 병합

“비중첩”은 같은 baseline에서 서로 다른 범위가 바뀐 경우다. 예를 들어 다음
baseline을 사용한다.

```text
work: base
life: base
```

1. B에서 `work: base`를 `work: local`로 편집하고 note를 계속 열어 둔다.
2. 다른 프로그램은 실제 B 파일의 `life: base`만 `life: external`로 바꾼다.
3. 고정 sleep 대신 editor, disk, CRDT hash가 같아질 때까지 관찰한다.
4. B editor와 disk가 다음 두 줄을 모두 포함하는지 확인한다.
5. A에도 같은 결과가 한 번만 나타나며 conflict artifact는 없는지 확인한다.

```text
work: local
life: external
```

기대 결과: KAOS는 Obsidian의 host reload를 먼저 Y.Text에 넣지 않는다. exact 외부
후보를 controller의 3-way planner로 보내고, 비중첩 결과 하나를 targeted Y.Text
diff로 적용한다. 그래서 커서·선택·undo를 불필요한 전체 replace로 깨지 않는다.

### 12.3 열린 파일의 중첩 충돌

“중첩”은 local과 external이 baseline의 같은 줄 또는 맞닿은 hunk를 서로 다르게
고친 경우다.

1. 같은 baseline에서 B editor의 `work` 줄을 `work: local`로 바꾼다.
2. 다른 프로그램은 B disk의 같은 줄을 `work: external`로 바꾼다.
3. B의 원래 note가 `work: local`을 유지하는지 확인한다.
4. (1.12.0+ 기준) disk-sourced conflict artifact 파일이 생성되지 않고, 외부
   원문 전체가 서버 감사 로그(`revision.discarded`)에 기록되는지 확인한다.
5. 감사 기록이 A로 동기화되지 않는지 확인한다.
6. 최종 원래 note의 editor, Y.Text, disk가 다시 같은 local-primary 내용인지
   확인한다.

기대 결과: 중첩 내용을 추측해서 섞지 않는다. 열린 editor가 primary로 남고,
external candidate 전체가 local-only artifact에 한 번 보존된다. artifact 쓰기가
실패하면 note 전환과 정산은 fail-closed로 멈춰야 한다.

### 12.4 자동화된 열린 파일 acceptance

단일 데스크톱 QA vault에서 실제 Node filesystem write를 사용하는 controller를
실행한다.

```bash
npm run qa:open-external-merge -- \
  --port 9222 \
  --vault /tmp/kaos-qa-a \
  --out-dir qa-runs
```

기본 실행은 `clean`, `same-line`, `representation`, `cursor`, `quickadd-burst`,
`quickadd-heading`, `korean-prefix`, `move-delete`, `soak`을 모두 검증한다.
`quickadd-burst`라는 기존 case ID는 호환성을 위해 유지하지만, 각 `Vault.process()`
쓰기 뒤 disk/CRDT/editor 수렴과 idle baseline 정착을 확인한 다음 다음 쓰기를 시작하는
직렬 3회 시나리오다. 각 단계는 추가 3.5초 안정성 관찰로 hash와 artifact 불변까지
확인한다. 원인 영수증이 없는 실제 중첩 burst의 서로 다른 중간 후보는
artifact 없이 자동 소거하지 않는다. `quickadd-heading`은 문서 중간의 특정 제목 바로
아래에 문구를 삽입한다. 두 case 모두 최초 수렴 후 3.5초 동안 200ms 간격으로 계속
관찰하여 rollback이나 지연 conflict artifact도 실패로 본다.

`korean-prefix`는 실제 사고 형태인 editor `고미` 대 disk `고민하고 `를 검증하고,
`move-delete`는 같은 줄의 이동 대 삭제를 검증한다. 두 case 모두 열린 editor 내용을
primary로 유지하고 (1.12.0+ 기준) 외부 원문 전체를 byte-exact로 서버 감사 로그에
기록해야 한다. 자동으로 긴 문자열이나 이동 쪽을 선택하면 실패다. `soak`도 각
cycle마다 수렴 상태를 idle 뒤 다시 확인하고 3.5초 동안 hash와 감사 기록이
불변인지 검증한 다음 다음 변경으로 넘어간다.
artifact가 다른 장치로 전파되지 않는 local-only 성질은 12.3과 `s12c-conflict`에서
별도로 검증한다.
한 case만 재현할 때는 `--case quickadd-burst`처럼 지정한다. PASS 기준은 화면이
잠시 맞는 것이 아니라 disk/CRDT/editor hash, artifact 수, cursor/scroll/undo
assertion이 모두 맞는 것이다. controller는 CDP로 연결된 실제 vault 경로가
`--vault`와 다르면 파일을 만들거나 지우지 않고 중단한다.

### 12.5 재시작 데이터 유실 회귀

열린 note를 유지한 채 B에서 KAOS를 끄고, A의 원격 변경과 B의 로컬 편집을 만든
후 KAOS를 다시 켜는 경로는 별도 위험 시나리오다. v1.10.2에서 이 경로는 다음
출력으로 데이터 유실을 재현했던 과거 red baseline이다.

격리된 위 두 QA vault에서만 실행한다.

```bash
bun run qa/scripts/repro-open-file-reenable-data-loss.ts
```

```text
BUG CONFIRMED: ISSUE #22-B open-file path — local edit silently lost
```

현재 branch에서 위 문구가 나오면 알려진 결과가 아니라 release blocker다. 이
스크립트는 bug를 확인해도 non-zero exit code를 보장하지 않으므로 shell 종료
코드만으로 PASS 판정하지 않고 assertion과 최종 main file/artifact 내용을 함께
기록한다.

수정 후의 acceptance 기준:

- B의 main file에 `LOCAL_ON_B`가 남는다.
- (1.12.0+ 기준) `REMOTE_FROM_A`는 conflict artifact 파일이 아니라 CRDT
  병합/서버 감사 로그로 보존된다.
- 사용자 편집이 조용히 사라지지 않는다.

[`qa/scripts/repro-cold-relaunch-external-edit.ts`](../../qa/scripts/repro-cold-relaunch-external-edit.ts)는
B 프로세스를 찾아 강제 종료하고 고정된 user-data 경로로 재실행하는 파괴적
진단 도구다. 일반 검증 순서에는 포함하지 않는다. 전용 QA 프로세스와 경로가
정확히 일치한다는 것을 별도로 확인한 경우에만 사용한다.

## 13. 노트 A→B 전환과 IME 검증

전환 규칙은 의도적으로 작다.

```text
이미 시작된 A의 composition 종료
→ 새 입력 차단
→ A 외부 후보 정산
→ A flush 및 unbind
→ B disk/CRDT admission
→ B native load 및 exact binding
→ 입력 재개
```

클릭 이후 새 입력을 저장해 두었다가 B에 replay하지 않는다. authority lease,
IndexedDB recovery journal, exact replay, same-path adoption도 이 경로에 없다.

### 13.1 실제 Chromium IME 자동화

장치 A용 Obsidian이 9222 CDP port에서 실행 중일 때 다음을 실행한다.

```bash
npm run qa:editor-transition-ime -- \
  --port 9222 \
  --vault /tmp/kaos-qa-a
```

이 controller는 `Input.imeSetComposition`으로 실제 Chromium composition을 시작한
채 A→B를 요청한다. 연결된 실제 vault 경로가 `--vault`와 정확히 일치할 때만
`QA-scratch/transition-ime-{a,b}.md`를 만들며, 종료할 때 두 파일을 정리한다. PASS
조건은 다음과 같다.

- A에서 시작된 `한`이 A에만 확정된다.
- B의 editor와 disk는 B baseline 그대로이며 A marker가 섞이지 않는다.
- `compositionstart`와 `compositionend`가 관찰되고 A의 확정 내용이 유지된다.
- 이후 10회의 빠른 A↔B 전환 뒤에도 두 경로의 bytes가 바뀌지 않는다.

CDP가 없는 Android/iOS에서는 아래 수동 절차를 사용한다.

### 13.2 수동 IME/rollback 절차

1. A와 B에 눈에 띄게 다른 첫 줄을 넣고 둘 다 완전히 수렴시킨다.
2. A 마지막 줄에서 한글 조합을 시작하고 마지막 음절을 확정하기 전에 B를 누른다.
3. B에 A의 첫 줄이나 마지막 조합 문자가 잠깐이라도 보이는지 화면 녹화로
   확인한다.
4. 즉시 A를 다시 열어 조합 중이던 마지막 음절까지 남았는지 확인한다.
5. 영문과 한글로 A↔B를 20회 빠르게 반복하고 각 note의 고유 marker, cursor,
   undo/redo를 확인한다.
6. A가 열린 상태에서 외부 프로그램의 비중첩 수정을 만든 직후 같은 전환을
   반복한다.

다음 중 하나라도 보이면 실패다.

- A 내용이 B에 들어감
- B가 열린 뒤 1~3초 후 A 또는 이전 B 내용으로 rollback
- A의 마지막 조합 문자가 사라짐
- 클릭 뒤 입력이 B에 replay됨
- 정산 실패 알림 뒤에도 source를 버리고 target으로 전환됨

## 14. 실제 다른 단말의 수동 검증

다른 컴퓨터나 모바일은 이 controller가 CDP로 자동 조작하지 않는다. 다음 순서로
수동 증거를 남긴다.

1. 6.2절처럼 Worker를 `0.0.0.0`에 bind한다.
2. 단말 브라우저에서 `http://HOST_LAN_IP:8787/api/capabilities`를 확인한다.
3. 동일 commit의 KAOS bundle을 전용 QA vault에 설치한다. witness 명령이 필요하면
   `kaos-qa-harness`도 함께 설치하며 실제 vault에는 설치하지 않는다.
4. setup link 대신 Server URL, token, Vault ID를 수동 입력한다.
5. 장치 이름을 실제 장치별로 고유하게 지정한다.
6. 먼저 단순 edit roundtrip을 하고, 이어서 12.1~12.3과 13.2를 반복한다.
7. 각 장치의 명령 팔레트에서 `Start telemetry trace`를 실행하고 시나리오 후
   `Export safe telemetry trace`와 `Export safe witness bundle`을 실행한다.
8. `Show device identity`, 최종 파일 내용, conflict artifact 목록과 화면 캡처를
   함께 보존한다.

세 장치 quorum이나 실제 모바일 conflict-artifact 검증은 다음 수동 scenario를
기준으로 한다.

- [`s12a-three-device-passive-quorum.ts`](../../qa/obsidian-harness/scenarios/s12a-three-device-passive-quorum.ts)
- [`s12c-three-device-conflict-artifact.ts`](../../qa/obsidian-harness/scenarios/s12c-three-device-conflict-artifact.ts)

수집한 witness bundle은 오프라인으로 분석한다.

```bash
bun run qa:analyze-bundles -- device-a.ndjson device-b.ndjson --out qa-runs/manual-report.json
```

## 15. 증거와 판정

자동 controller는 기본적으로 `qa-runs/<timestamp>-<scenario>-<device>/`에 다음을
기록한다.

- `build-identity.json`
- `manifest-pre.json`, `manifest-post.json`
- `flight-trace.ndjson`
- `analyzer-report.json`
- `result.json`, `meta.json`, `run.log`

`qa-runs/`는 gitignored다. 재현 가능한 결함의 증거를 commit해야 한다면 token,
실제 경로, 파일명과 개인 내용을 제거한 별도 sanitized fixture/summary만 추가한다.

PASS는 UI가 잠시 같아 보이는 것으로 판정하지 않는다. 최소 조건은 다음과 같다.

- 두 장치가 같은 commit/bundle을 실행했다.
- 시나리오 assertion과 analyzer가 모두 PASS했다.
- disk, CRDT, 열린 경우 editor의 최종 상태가 기대값과 일치했다.
- 삭제 resurrection이나 예상 밖 conflict artifact가 없다.
- 외부 수정의 패배한 쪽도 필요한 경우 local artifact에 보존됐다.
- A→B 전환 중 path 간 content 이동, 지연 rollback 또는 IME 유실이 없다.

과거 red baseline이 재현되면 PASS 목록과 분리하고 release blocker로 기록한다.

## 16. 새 실행과 문제 해결

완전히 새 실행이 필요하면 기존 상태를 삭제하는 대신 다음 번호의 새 전용 경로를
사용한다.

- Worker: `/tmp/kaos-wrangler-qa-v1103-run2`
- Vaults: `/tmp/kaos-qa-a-run2`, `/tmp/kaos-qa-b-run2`
- Obsidian profile: `/tmp/kaos-obsidian-a-run2`, `/tmp/kaos-obsidian-b-run2`

자주 생기는 문제:

| 증상 | 먼저 확인할 것 |
|---|---|
| 다른 단말에서 capabilities가 열리지 않음 | `--ip 0.0.0.0`, LAN IP, 방화벽, Wi-Fi isolation |
| LAN setup link가 invalid | 의도된 보안 동작; Manual connection 사용 |
| 401/403 또는 ticket 오류 | Worker와 plugin의 token이 정확히 같은지 확인 |
| 두 장치가 연결됐지만 파일이 안 옴 | `vaultId`가 byte-for-byte 같은지 확인 |
| `__KAOS_QA__`가 없음 | QA product build, harness, `qaDebugMode`, plugin 활성화 확인 |
| 두 장치 bundle hash가 다름 | 둘 다 종료하고 build 후 두 vault를 다시 prepare |
| attachments/snapshots unavailable | 기본 로컬 Worker에는 R2가 없으므로 정상 |
| 모바일에서 HTTP/WebSocket 차단 | OS 정책과 브라우저 접근을 확인하고 신뢰된 HTTPS 사용 |

관련 설계와 현재 증거 상태는 다음 문서를 참고한다.

- [`engineering/live-editor-authority-policy.md`](../../engineering/live-editor-authority-policy.md)
- [`engineering/layer4-harness-status.md`](../../engineering/layer4-harness-status.md)
- [`server/README.md`](../../server/README.md)
