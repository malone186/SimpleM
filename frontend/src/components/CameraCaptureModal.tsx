// 네이티브(iOS/Android)용 자리 표시자.
//
// 네이티브에서는 expo-image-picker의 launchCameraAsync가 OS 카메라 앱을 그대로 띄우므로
// 앱 안에 카메라 화면을 따로 만들 필요가 없다. 웹 전용 구현(CameraCaptureModal.web.tsx)과
// 같은 이름으로 두어, 호출부가 플랫폼 분기 없이 import만 하면 되게 한다.
export type CapturedPhoto = { uri: string; mimeType: string; fileName: string };

export default function CameraCaptureModal(_props: {
  visible: boolean;
  onClose: () => void;
  onCapture: (photo: CapturedPhoto) => void;
}) {
  return null;
}
