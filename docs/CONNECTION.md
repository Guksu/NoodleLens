# 모델 연결 방식 비교와 확정 사항

조사일: 2026-10-06. 공식 문서(OpenAI·Anthropic·Chrome 개발자 문서, 지원 센터, 약관)를 기준으로 했습니다.
- **[확인]**: 공식 문서에서 직접 읽었거나 우리가 직접 측정한 내용입니다.
- **[미확인]**: 문서에 없거나 해석이 필요한 내용입니다.

## 확정 사항

| 항목 | 결정 | 근거 |
|---|---|---|
| 연결 방식 | **A. 사용자 본인 API 키(BYOK)** | 두 제공자 모두 공식 경로이고 서버가 필요 없음. 2026-10-06 사용자 확정 |
| 서버 | 두지 않음 | 확장 프로그램 페이지가 제공자 API를 직접 호출 |
| 요청 위치 | 사이드 패널 페이지 | service worker 수명 제약(아래 DESIGN 참고) |
| 플랜 로그인(B) | MVP에서 제외 | Claude는 서드파티 금지, OpenAI는 로컬 헬퍼가 필요해 보임(아래) |

## 비교

| | A. 사용자 API 키 | B. 계정(플랜) 로그인 |
|---|---|---|
| **OpenAI** | 가능 | **Sign in with ChatGPT**(2026-09-29 출시) [확인]. 오픈소스·로컬 개인 프로젝트는 승인 없이 쓸 수 있고, 유료·원격 호스팅 앱은 대기자 명단을 거쳐야 함 [확인] |
| **Anthropic** | 가능 | **불가**. 사전 승인 없이 서드파티가 claude.ai 로그인을 제공하거나 구독 자격증명을 대신 쓰는 것을 금지 [확인] |
| 무료·유료 계정 | API는 선불 크레딧으로 따로 결제. ChatGPT Plus/Pro, Claude Pro/Max 구독에는 API 사용이 포함되지 않음 [확인] | OpenAI는 플랜 사용량에서 차감. 대상은 Plus·Pro가 확실하고, Go·Free는 문서마다 다름 [확인/불일치] |
| 별도 과금 | 있음(사용량만큼 API 요금) | OpenAI는 플랜 한도 안에서 추가 과금 없음 [확인] |
| 브라우저 직접 호출 | 가능. 두 API 모두 CORS를 허용 [확인·실측]. Anthropic은 `anthropic-dangerous-direct-browser-access: true` 헤더 필요 [확인·실측] | OpenAI는 `127.0.0.1` 루프백 콜백 리스너를 요구하고, 토큰을 브라우저 저장소에 두지 말라고 명시 [확인] |
| 서버·로컬 프로그램 | 필요 없음 | 확장 프로그램만으로는 루프백·저장 요구를 맞추기 어려워 Native Messaging 로컬 헬퍼가 필요해 보임 [미확인/추정] |
| 텍스트·이미지·스트리밍 | 모두 지원 [확인] | OpenAI는 지원. 단 `store:false`·`stream:true` 필수, `max_output_tokens`·`temperature` 등은 쓸 수 없음 [확인] |
| 배포 조건 | 제품명에 "GPT"·"Claude" 사용 불가, 제휴·보증 암시 금지 [확인]. 두 회사 모두 클라이언트에 키를 두는 것은 위험하다고 경고 [확인] | OpenAI 플랜 연결은 "Continue with ChatGPT" 버튼·사용량 안내 등 UI 지침 준수 필요 [확인] |

### 실측한 것 (2026-10-06)
- 키 없이 `OPTIONS` 사전 요청: `api.openai.com/v1/responses`와 `api.anthropic.com/v1/messages` 모두 `access-control-allow-origin: *`를 돌려줌.
- Anthropic은 브라우저 헤더를 붙였을 때만 401 응답에도 `access-control-allow-origin: *`가 붙음.
- **OpenAI는 잘못된 키로 보낸 401 응답에 `access-control-allow-origin`이 없음.** CORS만으로는 오류 내용을 읽지 못해 확장 프로그램이 '네트워크 실패'로 잘못 안내했다. 그래서 두 API 호스트만 `host_permissions`로 요청한다(권한 설명은 [PRIVACY.md](PRIVACY.md)).
- 실제 확장 프로그램(Chrome for Testing 153)에서 무효한 키로 두 제공자의 실제 401을 받아 '키 확인' 안내가 나오는 것을 E2E로 확인했다(인증 단계 거절이라 과금 없음).

## 모델 목록 (2026-10-06 공식 문서 기준)

목록은 짧게 유지합니다(균형·고성능·저비용 각 1개). 가격은 입력/출력 1M 토큰당 달러입니다.

| 제공자 | 모델 id | 쓰임 | 가격 | 이미지 입력 |
|---|---|---|---|---|
| Anthropic | `claude-sonnet-5-5` (기본) | 균형 | $2 / $10 | 지원 |
| Anthropic | `claude-opus-5-5` | 고성능 | $4 / $20 | 지원 |
| Anthropic | `claude-haiku-4-5` | 빠름·저비용 | $1 / $5 | 지원 |
| OpenAI | `gpt-6.1-sol` (기본) | 균형 | $2 / $10 | 지원 |
| OpenAI | `gpt-6-astra` | 고성능 | $10 / $50 | 지원 |
| OpenAI | `gpt-6-luna` | 저비용 | $0.10 / $0.50 | 지원 |

- 이 모델 id들은 무효 키 E2E에서 요청 형식까지는 확인했지만, **유효한 키로 응답을 받은 것은 아직 아니다**([EVALUATION.md](EVALUATION.md)).
- Opus·Sonnet 5.5는 thinking이 기본으로 켜져 있어 텍스트보다 thinking 블록이 먼저 올 수 있다. thinking 토큰은 출력 토큰으로 과금되고 `max_tokens`에 포함된다 [확인]. 어댑터는 thinking 블록을 '추론 중' 상태로만 보여 주고 이전 답변을 다시 보낼 때 thinking 블록은 보내지 않는다.

## 제공자별 오류 처리 근거

| 상황 | Anthropic | OpenAI | NoodleLens 분류 |
|---|---|---|---|
| 잘못된 키 | 401 `authentication_error` | 401 | `auth` — 키 확인 안내, 설정 열기 |
| 권한 없음 | 403 `permission_error` | 403 | `permission` |
| 한도 | 429 `rate_limit_error` + `retry-after` | 429 `rate_limit_exceeded` | `rate_limit` — 재시도 가능, 초 안내 |
| 크레딧·지출 한도 | 429 + `enforced_spend_limit_reached` | 429 `insufficient_quota`·`credit_balance_exhausted` 등 | `quota` — 재시도해도 안 됨 |
| 혼잡 | 529 `overloaded_error`, 스트림 중 `error` 이벤트 | 503 `server_is_overloaded` | `overloaded` |
| 거절 | `stop_reason: "refusal"`(부분 출력 폐기 권장) | `response.refusal.delta`, `incomplete: content_filter` | `refusal` — 부분 응답 지움 |
| 스트림 도중 끊김 | `message_stop` 없이 종료 | `response.completed` 없이 종료 | `interrupted` — 받은 부분 보존 |

## B(플랜 로그인)를 다시 검토할 조건
- OpenAI가 브라우저 확장(또는 `chromiumapp.org` 리디렉트)을 Sign in with ChatGPT에서 공식 지원한다고 밝힐 때.
- 또는 Native Messaging 로컬 헬퍼를 두는 구조 변경을 받아들일 때. 이때도 Claude는 API 키 방식만 남는다.

## 출처
- Anthropic 모델·가격: https://platform.claude.com/docs/en/about-claude/models/overview , https://platform.claude.com/docs/en/about-claude/pricing
- Anthropic 브라우저 CORS 지원(2024-08-22): https://platform.claude.com/docs/en/release-notes/overview
- Anthropic TS SDK `dangerouslyAllowBrowser`: https://platform.claude.com/docs/en/cli-sdks-libraries/sdks/typescript
- Anthropic 스트리밍·오류: https://platform.claude.com/docs/en/build-with-claude/streaming , https://platform.claude.com/docs/en/api/errors
- 서드파티의 claude.ai 로그인 금지: https://code.claude.com/docs/en/agent-sdk/overview , https://code.claude.com/docs/en/legal-and-compliance
- Claude 구독과 API 별도 결제: https://support.claude.com/en/articles/9876003
- OpenAI 모델·가격·스트리밍 이벤트: https://developers.openai.com/api/docs/models , https://developers.openai.com/api/reference/resources/responses/streaming-events
- ChatGPT 구독과 API 별도 결제: https://help.openai.com/en/articles/9039756
- OpenAI 키 안전 가이드: https://help.openai.com/en/articles/5112595-best-practices-for-api-key-safety
- Sign in with ChatGPT: https://openai.com/index/devday-2026-recap/ , https://developers.openai.com/cookbook/articles/sign-in-with-chatgpt , https://developers.openai.com/siwc/token-sharing-open-source/sign-in , https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations
- 브랜드 가이드: https://openai.com/brand/ , https://www.anthropic.com/legal/trademark-guidelines
