import test from 'node:test';
import assert from 'node:assert/strict';
import { VmManager } from './vmManager';
import { tunnelManager } from './tunnel';
import { imageManager } from './imageManager';

test('Creating Windows 7 VM allocates a dedicated local port distinct from default port 3389 and does not use static port 41735', async () => {
  const origEnsureWithMeta = imageManager.ensureImageReadyWithMeta.bind(imageManager);
  imageManager.ensureImageReadyWithMeta = async () => {
    await new Promise((r) => setTimeout(r, 15));
    throw new Error('Unit test stubbed ISO download');
  };

  const manager = new VmManager();
  let win7VmId: string | null = null;
  try {
    const win7Vm = await manager.createVm({
      osId: 'windows-7',
      name: 'Windows 7 Test VM',
    });
    win7VmId = win7Vm.id;

    // Must not collide with default 3389
    assert.notEqual(win7Vm.localPort, 3389, 'Windows 7 local port must not collide with default port 3389');
    assert.equal(typeof win7Vm.localPort, 'number');
    assert.ok(win7Vm.localPort >= 3390, 'Windows 7 local port must be allocated from dynamic pool (>=3390)');
    assert.equal(win7Vm.deploymentStages?.length, 12, 'Windows 7 VM must track 12 deployment stages');

    // Verify that TunnelManager configures Windows 7 with dynamic port, never static 41735
    const win7Status = tunnelManager.getStatus(win7Vm.id);
    // Status preferred port for Windows 7 should be null (dynamic)
    assert.notEqual(win7Status.publicPort, 41735, 'Windows 7 must never reuse static port 41735');

    // Let background stubbed pipeline settle before cleanup
    await new Promise((r) => setTimeout(r, 40));
  } finally {
    if (win7VmId) {
      tunnelManager.stop(win7VmId);
      await manager.deleteVm(win7VmId);
    }
    imageManager.ensureImageReadyWithMeta = origEnsureWithMeta;
  }
});

test('Windows 7 Autounattend.xml includes full windowsPE disk/EULA pass, RAM/disk optimizations, and no Win10-only tags', async () => {
  const { buildWindowsAutounattendXml, resolvePreferredWimImageIndex } = await import('./vmManager');
  const fs = await import('node:fs');
  const path = await import('node:path');

  const xml7 = buildWindowsAutounattendXml({
    osId: 'windows-7',
    username: 'Administrator',
    password: 'StrongPassword123!',
    computerName: 'MOON-WIN7',
    wimIndex: 4,
  });

  assert.ok(xml7.includes('<settings pass="windowsPE">'));
  assert.ok(xml7.includes('<WillWipeDisk>true</WillWipeDisk>'));
  assert.ok(xml7.includes('<AcceptEula>true</AcceptEula>'));
  assert.ok(xml7.includes('<Value>4</Value>'));
  assert.ok(xml7.includes('HibernateEnabled'));
  assert.ok(xml7.includes('PagingFiles'));
  assert.ok(xml7.includes('SysMain'));
  assert.ok(xml7.includes('fDenyTSConnections'));
  assert.ok(xml7.includes('UserAuthentication'));
  assert.equal(xml7.includes('HideLocalAccountScreen'), false);
  assert.equal(xml7.includes('HideOnlineAccountScreens'), false);

  const xml10 = buildWindowsAutounattendXml({
    osId: 'windows-10',
    username: 'Administrator',
    password: 'StrongPassword123!',
    computerName: 'MOON-WIN10',
    wimIndex: 1,
  });
  assert.ok(xml10.includes('<Type>EFI</Type>'));
  assert.ok(xml10.includes('<HideLocalAccountScreen>true</HideLocalAccountScreen>'));

  const realWin7Iso = path.resolve(process.cwd(), 'data/iso/windows-7-sp1-x64.iso');
  if (fs.existsSync(realWin7Iso)) {
    const detectedIdx = resolvePreferredWimImageIndex(realWin7Iso, 'windows-7');
    assert.equal(detectedIdx, 4);
  }
});

