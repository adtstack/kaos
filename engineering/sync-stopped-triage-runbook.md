# Sync Stopped 트리아지 런북

"동기화가 안 됨"으로 보이는 정지는 서로 다른 4가지 메커니즘에서 온다. 이 런북은
1.13.3의 `KAOS: Run sync check` 커맨드 판정을 기준으로 원인을 특정하고 조치한다.
(커맨드 이전 버전에서는 각 단계의 로그/알림 시그니처로 동일하게 진단한다.)

## 1단계 — 판정 수집

영향 기기에서 `KAOS: Run sync check` 실행. 결과 톤/코드에 따라 아래 표로 이동.

| sync-check 코드 | 원인 | 조치 |
|---|---|---|
| `room-echo-mismatch` | 서버가 다른 룸으로 응답 (호스트 라우팅 불일치) | host/vaultId 설정 확인, 서버 재배포 이력 점검 |
| `stale-room-suspected` | **과거 vaultId 룸에 접속 중** (전형: 룸 781 vs 로컬 4,040) | 2단계 — 룸 정합 |
| `schema-plugin-older-than-room` / `...-than-server` | 플러그인 구버전 (모바일 수동 설치 지연) | 플러그인 업데이트 후 재시작 |
| `schema-server-older-than-plugin` | 서버 구버전 | `kaosctl update` (server 0.8.x) |
| `projection-stalled-suspected` / `projection-gate-closed` | 공유 exclude 정책 게이트 폐쇄로 다운로드 동결 | 3단계 — 게이트 |
| `safety-brake-active` | 로컬 발산 > (20개 & 25%) — 덮어쓰기 보류 (1.13.3부터 creates는 계속 진행) | 4단계 — 브레이크 |
| `idb-error` | IndexedDB 실패 | 기기의 KAOS 캐시 초기화(`reset-cache`) 후 재동기화 |
| `server-unreachable` | 서버 자체 불가 | capabilities/네트워크 → 서버 상태 |

알림/로그 시그니처(커맨드 없이):
- "Shared exclude policy is invalid; remote files remain protected" → 3단계
- "CRDT schema version N is newer than this plugin supports" → 플러그인 업데이트
- "Reconcile safety brake — refusing to overwrite…" → 4단계
- "Room identity changed … restarting sync" → 페어링 직후 정상 로그 (1.13.3+)
- "KAOS: local cache is still loading — remote changes will apply once it
  finishes." → 하이드레이션 게이트 (revert-guards 빌드+, 6단계)

## 2단계 — 룸 정합 (stale-room)

1. 모든 기기에서 설정 → Sync status 의 **Vault ID** 를 대조. 서로 다르면:
   - 올바른(최신) 룸을 기준으로 옛 기기를 다시 페어링. **1.13.3+는 재페어링이
     룸-scoped 상태를 자동 리셋하고 런타임을 재시작한다.**
   - 1.13.3 미만: 수동 리셋 절차 — 대상 기기에서 (a) KAOS 비활성화, (b)
     `.obsidian/plugins/kaos/data.json` 에서 `_diskIndex`, `_blobHashCache` 키 삭제,
     (c) 브라우저/앱 저장소의 `kaos:<옛vaultId>` IndexedDB 삭제, (d) 재활성화 후
     새 링크로 페어링. (data.json 복사로 온 파일이면 vaultId 값 자체가 옛 룸이다.)
2. 룸이 비었는데 로컬에 파일이 많으면(신규 룸 시드) `stale-room` 오탐이 아닌지
   `activePathCount` 추이로 확인 — 시드가 진행되면 카운트가 올라간다.

## 3단계 — 게이트 (projection)

`SYSTEM/SETTING/kaos-exclude.md` 의 CRDT 바인딩/내용 점검:
- 64KB 초과, 비-텍스트, 경로 바인딩 중복이면 게이트가 닫힌 채 재시도된다.
- 대시보드 Conflicts/Attention 에 해당 문서가 있으면 먼저 해결.
- 임시 우회: 데스크톱(정상 기기)에서 컨트롤 파일을 수정해 수렴시키면 모든 기기의
  게이트가 다시 열린다.

## 4단계 — 브레이크

- 1.13.3부터 브레이크는 **덮어쓰기만** 보류하고 신규 다운로드(creates)는 계속한다.
  이전 버전에서 정지했다면: 원인 발산(어느 쪽이 옳은지)을 `Export diagnostics`
  로 확인 후, 올바른 쪽을 유지하고 다른 쪽을 정리(로컬 편집 폐기/수용)하면 다음
  reconcile에 브레이크가 풀린다.
- 반복 발동이면 발산 원천(외부 편집 도구, 양쪽 동시 대량 편집)을 찾는다.

## 5단계 — 룸 다이어트 (선택, 대형 볼트)

**기존 룸은 다이어트되지 않는다** — exclude는 프로젝션/ingest만 막을 뿐 CRDT 문서
크기는 그대로다. 모바일 일상 사용을 위해 문서 자체를 줄이려면 새 룸으로 이주:

1. 데스크톱에서 `SYSTEM/SETTING/kaos-exclude.md` 에 제외 패턴 작성 (예: `OLD/`).
2. 새 룸 클레임(새 vaultId) → 첫 reconcile가 exclude 적용된 상태로 시드.
3. 각 기기를 새 링크로 재페어링 (1.13.3+ 자동 리셋).
4. 구 룸의 `kaos:<옛vaultId>` IDB는 기기별로 남는다 — 정리 커맨드는 followups.
5. 이주 전 `Run sync check` 로 새 룸 doc 크기(`docBytes`)와 hydration 시간(
   `localPersistenceReadyMs`)을 기록해 두면 효과를 수치로 비교할 수 있다.

## 6단계 — 하이드레이션 게이트 (revert-guards 빌드+)

로컬 IndexedDB 하이드레이션이 완료되기 전에는 authoritative reconcile가
**conservative로 강등**된다(원격→디스크 반영 보류, 생성·블롭 다운로드는 계속).
"동기화 안 됨"처럼 보이지만 기다리면 자동 승격된다.

- 시그니처: flight event `reconcile-mode-downgraded-unhydrated-local`,
  Notice "local cache is still loading…", 승격 시
  `local-persistence-ready-reconcile-promotion`.
- 대형 볼트에서 3초 타임아웃 후 하이드레이션이 수 초 더 걸리는 것은 정상
  (5단계의 `localPersistenceReadyMs` 로 수치 확인). 승격이 몇 분 넘게 오지
  않으면 `idb-error` 경로(1단계 표)와 함께 볼 것.
- **idbError는 하이드레이션 성공 이후에 래치돼도 conservative를 고정**한다
  (런타임 IDB 쓰기 오류 포함, blob 권한과 동일한 fail-closed 규칙).
  해제는 재시작(오류 해소 시) 또는 긴급 명령뿐이다.
- **긴급 탈출구**: `KAOS: Force authoritative reconcile without the local
  cache gate (emergency)` — 서버가 이 기기보다 뒤처이지 않음을 확신할 때만.
  강제 실행은 `reconcile-forced-unhydrated` 로 기록된다.

되돌림(점프백) 진단 시그니처(revert-guards 빌드+):
- `disk-wins-stale-editor-excluded` / `crdt-wins-stale-editor-excluded` —
  낡은 에디터 렌더가 권한배제된 사건 (재발 시 원인인 펜스/리로드 지연 확인).
- `external-disk-host-set-uncorrelated-pass` — 상관 없이 통과한 호스트 머지
  (외부 동기화 도구 사용 여부 확인).
- `*-crdt-authoritative-baseline-text-unknown` — CRDT 승리로 덮어썼는데
  baseline text 저장소에 원본이 없어 감사로그로 남긴 사건.

## 참고 — 1.13.3 변경이 이 런북에 미치는 것

- 페어링/룸 전환 시 상태 리셋 + 런타임 재시작 자동화 (2단계 수동 절차 불필요).
- 브레이크가 creates를 차단하지 않음 (4단계의 "전면 정지" 사례 소멸).
- data.json에서 fs 상태 분리 — data.json 복사 사고로 인한 위조 장부 원천 차단.
