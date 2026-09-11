import { expect, test } from '@playwright/test';

import {
  TEST_LAUNCHER_ENTRIES,
  getLauncherEntry,
  validateLauncherMenu
} from '../../config/test-launcher-menu';

test.describe('统一中文测试启动器菜单', () => {
  test('编号唯一且所有入口映射到已有 npm script', () => {
    expect(() => validateLauncherMenu()).not.toThrow();
    expect(TEST_LAUNCHER_ENTRIES.map(entry => entry.number)).toEqual([
      1, 2, 3, 4, 5,
      6, 7, 8,
      9,
      10, 11, 12,
      13, 14, 15, 16, 17,
      18, 19, 20,
      90, 91
    ]);
    for (const entry of TEST_LAUNCHER_ENTRIES) {
      expect(entry.npmScript).toBeTruthy();
    }
  });

  test('关键业务编号指向当前正式 Case', () => {
    expect(getLauncherEntry(1)?.npmScript).toBe('test:registration:personal');
    expect(getLauncherEntry(3)?.npmScript).toBe('test:deposit:claim');
    expect(getLauncherEntry(6)?.npmScript).toBe('test:client:u2u');
    expect(getLauncherEntry(7)?.npmScript).toBe('test:transfer:approve');
    expect(getLauncherEntry(10)?.npmScript).toBe('test:wealth:subscribe:approve');
    expect(getLauncherEntry(91)?.npmScript).toBe('regression');
  });
});
