import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEPLOYMENT_STAGE_ORDER,
  calculateDeploymentOverallPercent,
  calculateSafeVmMemoryBudget,
  classifyQemuExitCause,
  createInitialDeploymentStages,
  evaluateIsoChecksum,
  getActiveDeploymentStageKey,
  getLifecycleDisplayInfo,
  mapVmStatusToLifecycleState,
  parseCgroupOomControl,
  updateDeploymentStage,
} from './win7Lifecycle';

test('mapVmStatusToLifecycleState maps all lifecycle stages accurately while preserving VmExtendedStatus compatibility', () => {
  assert.equal(mapVmStatusToLifecycleState('Queued'), 'PENDING');
  assert.equal(mapVmStatusToLifecycleState('Downloading Image'), 'DOWNLOADING_ISO');
  assert.equal(mapVmStatusToLifecycleState('Preparing'), 'PREPARING');
  assert.equal(mapVmStatusToLifecycleState('Creating Disk'), 'PREPARING');
  assert.equal(mapVmStatusToLifecycleState('Installing'), 'INSTALLING');
  assert.equal(mapVmStatusToLifecycleState('Installing', { isRebooting: true }), 'REBOOTING');
  assert.equal(mapVmStatusToLifecycleState('Installing', { rdpLocalConnected: true }), 'VERIFYING');
  assert.equal(
    mapVmStatusToLifecycleState('Installing', { lifecycleHint: 'CONFIGURING_RDP' }),
    'CONFIGURING_RDP'
  );
  assert.equal(mapVmStatusToLifecycleState('Booting'), 'BOOTING');
  assert.equal(mapVmStatusToLifecycleState('Booting', { isRebooting: true }), 'REBOOTING');
  assert.equal(mapVmStatusToLifecycleState('Ready'), 'READY');
  assert.equal(mapVmStatusToLifecycleState('Stopped'), 'STOPPED');
  assert.equal(mapVmStatusToLifecycleState('Failed'), 'ERROR');

  assert.equal(getLifecycleDisplayInfo('READY').badgeColor, 'green');
  assert.equal(getLifecycleDisplayInfo('ERROR').isActive, false);
});

test('parseCgroupOomControl and classifyQemuExitCause detect container OOM kills and runtime errors honestly', () => {
  const parsed = parseCgroupOomControl('oom_kill_disable 0\nunder_oom 1\noom_kill 3\n');
  assert.equal(parsed.oomKillDisable, false);
  assert.equal(parsed.underOom, true);
  assert.equal(parsed.oomKillCount, 3);

  const oomCause = classifyQemuExitCause({
    osName: 'Windows 7',
    exitCode: null,
    signal: 'SIGKILL',
    oomKillDelta: 1,
    memAvailableMb: 120,
  });
  assert.equal(oomCause.oomDetected, true);
  assert.equal(oomCause.causeCode, 'CONTAINER_OOM_KILL');
  assert.ok(oomCause.remediation);

  const diskFullCause = classifyQemuExitCause({
    osName: 'Windows 7',
    exitCode: 1,
    signal: null,
    stderrTail: 'qemu-system-x86_64: Failed to write block: No space left on device',
  });
  assert.equal(diskFullCause.oomDetected, false);
  assert.equal(diskFullCause.causeCode, 'DISK_FULL');

  const cleanStop = classifyQemuExitCause({
    osName: 'Windows 7',
    exitCode: 0,
    signal: null,
    requestedShutdown: true,
  });
  assert.equal(cleanStop.causeCode, 'ACPI_SHUTDOWN');
  assert.equal(cleanStop.oomDetected, false);
});

test('calculateSafeVmMemoryBudget prevents host RAM overcommit and reserves host + overlayfs installation headroom', () => {
  // 12 GiB container with 9.2 GiB free (NBD streaming, no 3.1 GiB local ISO)
  const safeWin7 = calculateSafeVmMemoryBudget({
    osId: 'windows-7',
    requestedMemoryMb: 2048,
    hostTotalMb: 11960,
    hostAvailableMb: 9200,
    isMemoryBackedOverlay: true,
    existingDiskMb: 0,
    attachInstallerIso: true,
    otherActiveQemuMb: 0,
  });
  assert.equal(safeWin7.allowed, true);
  assert.equal(safeWin7.allocatedMemoryMb, 1024);
  assert.equal(safeWin7.adjusted, true);
  assert.ok(safeWin7.headroomAfterMb >= 256);

  // If 3.1 GiB ISO was cached in overlayfs leaving only 6000 MiB available, block before OOM crash
  const blockedWithLocalIso = calculateSafeVmMemoryBudget({
    osId: 'windows-7',
    requestedMemoryMb: 1024,
    hostTotalMb: 11960,
    hostAvailableMb: 6000,
    isMemoryBackedOverlay: true,
    existingDiskMb: 0,
    attachInstallerIso: true,
    otherActiveQemuMb: 0,
  });
  assert.equal(blockedWithLocalIso.allowed, false);
  assert.equal(blockedWithLocalIso.code, 'INSUFFICIENT_HOST_MEMORY');

  // Multi-VM overcommit prevention
  const overcommit = calculateSafeVmMemoryBudget({
    osId: 'windows-7',
    requestedMemoryMb: 1024,
    hostTotalMb: 4096,
    hostAvailableMb: 2048,
    isMemoryBackedOverlay: false,
    existingDiskMb: 0,
    attachInstallerIso: false,
    otherActiveQemuMb: 2048,
    hostReserveMb: 1536,
  });
  assert.equal(overcommit.allowed, false);
  assert.equal(overcommit.code, 'OVERCOMMIT_PREVENTED');
});

test('evaluateIsoChecksum verifies exact SHA-256 digests and rejects mismatches', () => {
  const expected = '36f4fa2416d0982697ab106e3a72d2e120dbcdb6cc54fd3906d06120d0653808';
  assert.equal(evaluateIsoChecksum(expected.toUpperCase(), expected).verified, true);
  assert.equal(evaluateIsoChecksum('0000', expected).status, 'MISMATCH');
  assert.equal(evaluateIsoChecksum(expected, undefined).status, 'UNAVAILABLE');
});

test('calculateSafeVmMemoryBudget permits Windows 10 2048 MiB on idle 12 GiB container and covers all lifecycle badges', () => {
  const win10Ok = calculateSafeVmMemoryBudget({
    osId: 'windows-10',
    requestedMemoryMb: 4096,
    hostTotalMb: 11960,
    hostAvailableMb: 9121,
    isMemoryBackedOverlay: true,
    existingDiskMb: 0,
    attachInstallerIso: true,
    otherActiveQemuMb: 0,
  });
  assert.equal(win10Ok.allowed, true);
  assert.equal(win10Ok.allocatedMemoryMb, 2048);

  for (const state of [
    'PENDING',
    'DOWNLOADING_ISO',
    'PREPARING',
    'INSTALLING',
    'REBOOTING',
    'BOOTING',
    'CONFIGURING_NETWORK',
    'CONFIGURING_RDP',
    'VERIFYING',
    'READY',
    'STOPPED',
    'ERROR',
  ] as const) {
    const info = getLifecycleDisplayInfo(state);
    assert.equal(info.label, state);
  }
});

test('12-stage deployment helpers track stages, skipped cached ISO, and reservedIsoDownloadMb step-down', () => {
  assert.equal(DEPLOYMENT_STAGE_ORDER.length, 12);
  assert.equal(calculateDeploymentOverallPercent(createInitialDeploymentStages('pending')), 0);
  let stages = createInitialDeploymentStages('active');
  assert.equal(stages.length, 12);
  assert.equal(getActiveDeploymentStageKey(stages), 'creating_vps');
  assert.equal(calculateDeploymentOverallPercent(stages), 3);

  stages = updateDeploymentStage(stages, 'creating_vps', 'completed', 'Created');
  stages = updateDeploymentStage(stages, 'allocating_resources', 'completed', '1024 MiB');
  stages = updateDeploymentStage(stages, 'preparing_storage', 'completed');
  stages = updateDeploymentStage(stages, 'downloading_iso', 'active', '50%');
  assert.equal(getActiveDeploymentStageKey(stages), 'downloading_iso');

  const midPercent = calculateDeploymentOverallPercent(stages, {
    status: 'downloading',
    downloadedBytes: 500,
    totalBytes: 1000,
    percent: 50,
    cachedReused: false,
    checksumVerified: false,
    resumable: true,
  });
  assert.ok(midPercent > 25 && midPercent < 40, `Expected mid-download percent around 29%, got ${midPercent}`);

  // Cached ISO skips downloading_iso cleanly and counts toward completion
  let cachedStages = updateDeploymentStage(stages, 'downloading_iso', 'skipped', 'Cached ISO reused');
  cachedStages = updateDeploymentStage(cachedStages, 'verifying_iso', 'completed', 'SHA-256 OK');
  for (const key of DEPLOYMENT_STAGE_ORDER) {
    const st = cachedStages.find((s) => s.key === key);
    if (st && st.status === 'pending') {
      cachedStages = updateDeploymentStage(cachedStages, key, 'completed');
    }
  }
  assert.equal(calculateDeploymentOverallPercent(cachedStages), 100);

  // reservedIsoDownloadMb reduces 1024 -> 768 MiB when memory-backed overlay headroom is tight
  const stepDownWin7 = calculateSafeVmMemoryBudget({
    osId: 'windows-7',
    requestedMemoryMb: 1024,
    hostTotalMb: 11960,
    hostAvailableMb: 10200,
    isMemoryBackedOverlay: true,
    existingDiskMb: 0,
    attachInstallerIso: true,
    reservedIsoDownloadMb: 3200,
    otherActiveQemuMb: 0,
  });
  assert.equal(stepDownWin7.allowed, true);
  assert.equal(stepDownWin7.allocatedMemoryMb, 768);
  assert.equal(stepDownWin7.adjusted, true);
});

