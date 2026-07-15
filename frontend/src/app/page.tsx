import { redirect } from "next/navigation";

// [루트 리다이렉션 페이지]
// 사용자가 최초로 웹 브라우저를 열어 루트 주소에 접근했을 때,
// 핵심 캔버스인 /dashboard 로 즉시 이동하도록 연결합니다.
export default function RootPage() {
  redirect("/dashboard");
}
