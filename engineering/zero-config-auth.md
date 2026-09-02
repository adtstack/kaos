# KAOS 기기 키 인증 설계

KAOS의 동기화 권한은 공유 bearer token이 아니라 **승인된 기기 개인키의 서명**으로
부여한다. Config Durable Object가 기기·권한·세션의 단일 기준이다.

## 기기와 권한

| 환경 | 개인키 보관 | 기본 권한 |
| --- | --- | --- |
| Obsidian 데스크톱·모바일 | IndexedDB의 비추출형 P-256 키 | Member 또는 Owner |
| 상시 헤드리스 서버 | 서비스 전용 `0600` identity 파일 | Member |
| 개인 터미널 CLI | 사용자 상태 디렉터리의 `0600` identity 파일 | Member |
| CI·일회성 컨테이너 | 지원하지 않음 | 없음 |

브라우저 키는 JavaScript가 원문을 내보낼 수 없도록 생성한다. 기기·Obsidian 프로필이
완전히 침해된 상황까지 막지는 못하므로, 폐기와 짧은 세션으로 노출 시간을 제한한다.

## 인증 흐름

1. 새 기기는 Owner가 만든 단일 사용·짧은 만료 초대로 pending 등록을 요청한다.
2. Owner는 기기 이름, 공개키 지문, 상호 대조 코드를 확인해 승인한다.
3. 활성 기기는 서버 nonce에 P-256 서명을 제출해 5분 이하의 기기 세션을 받는다.
4. HTTP는 `Authorization` 헤더만 사용한다. WebSocket은 단일 사용·5분 이하 ticket을
   `Sec-WebSocket-Protocol`으로 한 번만 전달한다.
5. 매 동기화 작업은 현재 `authGeneration`, 기기 상태, 역할을 Config DO에서 다시
   확인한다.

URL 쿼리 token/ticket과 장기 bearer token은 거부한다. 초대값·세션값·복구값·개인키는
감사 로그, 진단 번들, 설정 내보내기, 명령행에 남기지 않는다.

## 폐기와 복구

Owner가 기기를 폐기하거나 권한을 바꾸면 해당 기기의 세션·ticket·WebSocket 연결을
즉시 종료하고 `authGeneration`을 증가시킨다. Owner를 모두 잃었을 때만 별도 `0600`
recovery 파일로 전체 폐기를 명시 확인해 실행한다. 복구는 모든 기존 기기·세션·초대를
무효화하고, 새 Owner와 새 복구 검증값을 한 트랜잭션에서 만든다.

## 레거시 전환

기존 공유 토큰은 최대 7일 동안 **승인 대기 등록 요청**에만 쓸 수 있다. 동기화,
Owner 권한, URL/QR 전달에는 사용할 수 없으며, 기간 종료 시 서버와 클라이언트는
레거시 경로와 평문 설정을 모두 거부한다.
