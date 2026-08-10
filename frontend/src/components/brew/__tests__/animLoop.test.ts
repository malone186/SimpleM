// 반복이 진짜 반복되는지 확인한다.
//
// 배경: RN의 Animated.loop은 useNativeDriver:true면 JS 반복 경로를 타지 않고 네이티브에
// iterations를 넘긴다. 그런데 네이티브 모듈이 없는 환경(웹)에서도 그 분기를 타 버려서,
// 결과적으로 한 바퀴만 돌고 영영 멈춘다. 브루가 '한 번 움직이고 마는' 원인이었다.
// jest에서는 Animated 자체를 굴릴 수 없으므로(네이티브 드라이버로 넘어간 값은 JS에서
// 변하지 않는다) 반복을 책임지는 startLoop만 가짜 애니메이션으로 검사한다.
import { startLoop } from '../../../lib/animLoop';

/** start/stop만 흉내 내는 가짜 애니메이션 */
const fake = (onStart: (cb: (r: { finished: boolean }) => void) => void) =>
  ({ start: onStart, stop: () => {} }) as any;

describe('startLoop', () => {
  it('한 바퀴가 끝나면 다음 바퀴를 시작한다', () => {
    let cycles = 0;
    startLoop(() => {
      cycles += 1;
      // 5바퀴째에 '끊겼다'고 알려 스스로 멎게 한다 (테스트가 무한히 돌지 않도록)
      return fake((cb) => cb({ finished: cycles < 5 }));
    });
    expect(cycles).toBe(5);
  });

  it('stop() 뒤에는 늦게 도착한 완료 콜백이 있어도 다시 시작하지 않는다', () => {
    let cycles = 0;
    // 배열로 받아 둔다 — 콜백 안에서 대입한 변수는 TS가 계속 null로 좁혀 버린다
    const pending: Array<(r: { finished: boolean }) => void> = [];
    const handle = startLoop(() => {
      cycles += 1;
      return fake((cb) => { pending.push(cb); });
    });

    expect(cycles).toBe(1);
    handle.stop();
    pending[0]({ finished: true }); // 멈춘 뒤 도착한 콜백
    expect(cycles).toBe(1);
  });

  it('끊긴 애니메이션(finished=false)은 다시 시작하지 않는다', () => {
    let cycles = 0;
    startLoop(() => {
      cycles += 1;
      return fake((cb) => cb({ finished: false }));
    });
    expect(cycles).toBe(1);
  });
});

describe('Animated.loop 재도입 방지', () => {
  // 이 파일들에서 Animated.loop을 다시 쓰면 웹에서 조용히 한 바퀴만 돌게 된다.
  // (accessories.tsx는 useNativeDriver를 웹에서 끄는 방식으로 이미 피해 가고 있어 제외)
  const fs = require('fs') as typeof import('fs');
  const path = require('path') as typeof import('path');
  const dir = path.join(__dirname, '..');

  it.each(['Brew.tsx', 'Flipbook.tsx', 'brewMotions.ts'])('%s는 Animated.loop을 쓰지 않는다', (file) => {
    const src = fs.readFileSync(path.join(dir, file), 'utf8');
    // 주석에서 설명하려고 언급하는 건 허용 — 실제 호출만 잡는다
    const calls = src
      .split('\n')
      .filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*'))
      .filter((line) => line.includes('Animated.loop('));
    expect(calls).toEqual([]);
  });
});
