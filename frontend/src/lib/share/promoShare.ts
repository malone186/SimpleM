// 홍보물 복사·저장·공유 헬퍼 (백엔드 B)
//
// 앱(iOS/Android)과 웹이 쓸 수 있는 수단이 서로 달라서, 화면이 분기를 신경 쓰지 않도록
// 여기서 흡수한다.
//
//   문구 복사 : 웹 navigator.clipboard → 실패 시 textarea 폴백 / 앱 RN Clipboard
//   이미지 복사: 웹만 가능 (ClipboardItem). 앱 OS는 이미지 클립보드 API를 안 열어준다
//   이미지 저장: 웹 다운로드 / 앱은 공유 시트(사진에 저장·파일에 저장)로 대신
//   이미지 공유: 앱 = 캐시에 내려받아 expo-sharing 공유 시트 → 여기서 인스타그램·카카오톡
//                밴드 등이 뜬다. 인스타그램 스토리도 이 시트에서 고른다.
//                웹 = Web Share API(files) → 미지원 브라우저는 다운로드 + 문구 복사로 폴백
//
// 인스타그램 스토리에 '바로' 꽂아 넣는 건 네이티브 모듈(iOS 페이스트보드 스티커 /
// 안드로이드 ADD_TO_STORY 인텐트)이 필요해 Expo 관리형에서는 불가능하다. 대신 공유 시트에
// Instagram이 뜨고 거기서 스토리를 고르면 되므로, 문구를 미리 복사해 주는 것까지 묶어
// 실제 흐름이 끊기지 않게 했다.
import { Linking, Platform, Share } from 'react-native';
import * as Sharing from 'expo-sharing';

/** 앱에서 이미지 클립보드가 없다 — 화면이 '이미지 복사' 버튼 노출 여부를 정할 때 쓴다 */
export const canCopyImage =
  Platform.OS === 'web' &&
  typeof navigator !== 'undefined' &&
  typeof (globalThis as any).ClipboardItem !== 'undefined' &&
  !!navigator.clipboard?.write;

/** 웹에서만 진짜 '파일 다운로드'가 된다 (앱은 공유 시트로 대신) */
export const canDownload = Platform.OS === 'web';

// ---------------------------------------------------------------------------
// 문구 복사
// ---------------------------------------------------------------------------

/** 텍스트를 클립보드에 복사한다. 실패하면 false — 호출부가 공유 시트로 폴백한다. */
export async function copyText(text: string): Promise<boolean> {
  if (!text) return false;
  if (Platform.OS === 'web') {
    try {
      if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch {
      // 권한 거부·비보안 컨텍스트 — 아래 execCommand 폴백으로
    }
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch {
      return false;
    }
  }
  try {
    // RN 코어 Clipboard는 deprecated 경고가 뜨지만 0.81에서도 정상 동작한다.
    // expo-clipboard를 넣으면 네이티브 모듈이 추가돼 개발 빌드를 다시 만들어야 하므로
    // (OTA로 못 나감) 여기서는 코어 모듈을 쓴다.
    const { Clipboard } = require('react-native');
    Clipboard.setString(text);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// 이미지 가져오기·저장·복사 (웹)
// ---------------------------------------------------------------------------

async function fetchBlob(url: string): Promise<Blob> {
  // cache:'no-store'가 핵심 — <Image>가 먼저 no-cors로 받아 둔 캐시 항목을 fetch(cors)가
  // 재사용하면 브라우저가 CORS 위반으로 막아버린다(실측: 이미지가 화면에 잘 떠 있는데도
  // '이미지 복사·저장'만 실패). 캐시를 건너뛰면 CORS 헤더가 붙은 응답을 새로 받는다.
  const res = await fetch(url, { mode: 'cors', cache: 'no-store' });
  if (!res.ok) throw new Error(`이미지를 불러오지 못했습니다 (${res.status})`);
  return res.blob();
}

/** JPEG/WebP → PNG. 클립보드는 사실상 PNG만 받는다. */
async function toPngBlob(blob: Blob): Promise<Blob> {
  if (blob.type === 'image/png') return blob;
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0);
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('변환 실패'))), 'image/png')
  );
}

/** 이미지를 클립보드에 복사 (웹 전용). 붙여넣기로 바로 인스타·카톡에 올릴 수 있다. */
export async function copyImage(url: string): Promise<boolean> {
  if (!canCopyImage) return false;
  const ClipboardItemCtor = (globalThis as any).ClipboardItem;
  try {
    // Safari는 사용자 제스처가 살아 있는 동안에만 write를 허용한다 — fetch를 await하면
    // 제스처가 끊기므로 Promise를 그대로 넘기는 형태를 먼저 시도한다.
    await navigator.clipboard.write([
      new ClipboardItemCtor({ 'image/png': fetchBlob(url).then(toPngBlob) }),
    ]);
    return true;
  } catch {
    try {
      const png = await toPngBlob(await fetchBlob(url));
      await navigator.clipboard.write([new ClipboardItemCtor({ 'image/png': png })]);
      return true;
    } catch {
      return false;
    }
  }
}

/** 앱: 이미지를 캐시에 내려받아 로컬 file:// 경로를 돌려준다 (공유 시트용) */
async function downloadToCache(url: string, filename: string): Promise<string> {
  const { Directory, File: FsFile, Paths } = require('expo-file-system');
  const dir = new Directory(Paths.cache, 'promo');
  if (!dir.exists) dir.create({ intermediates: true });
  const target = new FsFile(dir, filename);
  if (target.exists) target.delete();
  const file = await FsFile.downloadFileAsync(url, target, { idempotent: true });
  return file.uri;
}

/**
 * 이미지 저장 — 웹은 파일 다운로드, 앱은 공유 시트('사진에 저장'·'파일에 저장')로 넘긴다.
 * 반환: 'downloaded' | 'shared' | 'failed'
 */
export async function saveImage(url: string, filename: string): Promise<string> {
  if (Platform.OS === 'web') {
    try {
      const blob = await fetchBlob(url);
      const href = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = href;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(href), 3000);
      return 'downloaded';
    } catch {
      return 'failed';
    }
  }
  return (await shareImage(url, filename)) ? 'shared' : 'failed';
}

// ---------------------------------------------------------------------------
// 공유
// ---------------------------------------------------------------------------

/**
 * 이미지 파일 자체를 공유한다 — 여기서 뜨는 시트에 인스타그램·카카오톡·문자가 모두 있다.
 * 앱: 캐시에 받아 expo-sharing. 웹: Web Share API(files) → 미지원이면 다운로드 폴백.
 */
export async function shareImage(url: string, filename: string, message?: string): Promise<boolean> {
  const mimeType = filename.endsWith('.png')
    ? 'image/png'
    : filename.endsWith('.webp')
      ? 'image/webp'
      : 'image/jpeg';

  if (Platform.OS === 'web') {
    try {
      const nav = navigator as any;
      if (nav?.share && nav?.canShare) {
        const blob = await fetchBlob(url);
        const file = new (globalThis as any).File([blob], filename, { type: blob.type || mimeType });
        if (nav.canShare({ files: [file] })) {
          await nav.share({ files: [file], text: message || undefined });
          return true;
        }
      }
    } catch (e: any) {
      // 사용자가 시트를 닫은 경우(AbortError)는 실패가 아니다
      if (e?.name === 'AbortError') return true;
    }
    return (await saveImage(url, filename)) === 'downloaded';
  }

  try {
    const uri = await downloadToCache(url, filename);
    if (!(await Sharing.isAvailableAsync())) return false;
    await Sharing.shareAsync(uri, {
      mimeType,
      UTI: mimeType === 'image/png' ? 'public.png' : 'public.jpeg',
      dialogTitle: '홍보 이미지 공유',
    });
    return true;
  } catch {
    return false;
  }
}

/** 문구만 공유 (이미지 없이) — 블로그·메모 앱에 넘길 때 */
export async function shareText(message: string): Promise<boolean> {
  try {
    await Share.share({ message });
    return true;
  } catch {
    return false;
  }
}

/** 문자 앱을 홍보 문구가 채워진 상태로 연다 */
export async function openSms(body: string): Promise<boolean> {
  // iOS는 본문 구분자가 '&', 안드로이드는 '?' — 수신자 없이 열 때의 표준 형태다
  const sep = Platform.OS === 'ios' ? '&' : '?';
  const url = `sms:${sep}body=${encodeURIComponent(body)}`;
  try {
    await Linking.openURL(url);
    return true;
  } catch {
    return false;
  }
}

/** 링크 열기 (인스타그램 웹·네이버 블로그 글쓰기 등) */
export async function openUrl(url: string): Promise<boolean> {
  try {
    await Linking.openURL(url);
    return true;
  } catch {
    return false;
  }
}

/** 앱이 설치돼 있으면 인스타그램 스토리 카메라를 연다 (없으면 웹) */
export async function openInstagram(): Promise<void> {
  if (Platform.OS !== 'web') {
    try {
      await Linking.openURL('instagram://story-camera');
      return;
    } catch {
      // 미설치 — 웹으로
    }
  }
  await openUrl('https://www.instagram.com/');
}
