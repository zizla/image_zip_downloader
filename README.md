# Image ZIP Downloader

웹페이지 주소를 넣으면 그 안의 이미지를 나열하고, 여러 장을 골라 지정한 이름으로 ZIP 파일에 담아 저장합니다.

## 두 가지 버전

| | `index.html` (정적) | `server.js` + `public/index.html` (로컬 서버) |
|---|---|---|
| 실행 | 파일 하나, GitHub Pages에 그대로 배포 | `npm install` 후 `npm start` → http://localhost:5178 |
| 페이지 분석 | HTML + 같은 사이트의 스크립트/JSON 속 이미지 경로 | 헤드리스 Chrome/Edge로 실제 렌더링 + 자동 스크롤 |
| CORS | 사이트가 막으면 CORS 프록시 필요 | 제약 없음 |

## 기능

- 이미지 목록: `<img>`/`srcset`, 이미지 링크, `og:image`, CSS 배경, 스크립트·JSON 속 경로
- 썸네일과 원본을 짝지어, 받을 때는 원본으로 저장 (`원본` 배지)
- 주소의 `#key=value` 조건으로 필터 (예: `#hair=ロング` → 데이터에서 `"hair": "ロング"`인 이미지만)
- 다중 선택(Shift+클릭 범위 선택), 크기·검색 필터
- 이름 규칙: `{name}`, `{n}`(순번, 자릿수 지정), `{orig}`(원래 파일명), `{alt}`(설명)
- 받지 못한 파일은 ZIP 안의 `_failed.txt`에 기록

## GitHub Pages 배포

저장소 설정 → Pages → Branch를 `main` / `(root)`로 지정하면 `index.html`이 바로 열립니다.

## CORS 프록시

정적 버전은 브라우저에서 직접 요청하므로, `Access-Control-Allow-Origin` 헤더를 주지 않는 사이트는 프록시를 거쳐야 합니다.
화면의 “CORS 프록시 설정”에 한 줄에 하나씩 `{url}`(인코딩) 또는 `{raw}` 자리표시자로 입력합니다.
무료 공개 프록시는 자주 막히므로, 안정적으로 쓰려면 직접 만든 프록시(예: Cloudflare Workers)를 넣는 것을 권장합니다.
