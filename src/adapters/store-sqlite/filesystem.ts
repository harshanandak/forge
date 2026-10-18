import { realpathSync, statfsSync } from "node:fs";
import type { FilesystemSignals } from "../../core/state/fs-class.ts";

/** Adapter-local OS hooks; no platform dependency crosses into the store port. */
export interface FilesystemProbe {
  readonly platform: string;
  statfs(path: string): { readonly type: number };
  realpath(path: string): string;
}

const nativeProbe: FilesystemProbe = {
  platform: process.platform,
  statfs: statfsSync,
  realpath: realpathSync.native,
};

// Linux UAPI constants: https://github.com/torvalds/linux/blob/master/include/uapi/linux/magic.h
const remoteLinux = new Set([
  0x6969, // NFS
  0xff534d42,
  0x517b,
  0xfe534d42, // CIFS, SMB, SMB2
  0x5346414f,
  0x6b414653, // OpenAFS, Linux AFS
  0x00c36400,
  0x73757245,
  0x564c,
  0x01021997, // Ceph, Coda, NCP, 9P
]);
const localLinux = new Set([
  0xef53,
  0x58465342,
  0x9123683e, // ext2/3/4, XFS, Btrfs
  0x01021994,
  0x858458f6,
  0x794c7630, // tmpfs, ramfs, overlay
  0x5346544e, // NTFS: https://github.com/torvalds/linux/blob/master/fs/ntfs3/super.c
]);

export function probeFilesystem(
  parent: string,
  probe: FilesystemProbe = nativeProbe,
): Pick<FilesystemSignals, "driveType"> {
  try {
    if (probe.platform === "win32") {
      // libuv uses GetFinalPathNameByHandleW; only a returned UNC target proves remote.
      // https://github.com/libuv/libuv/blob/v1.x/src/win/fs.c (fs__realpath_handle)
      // A retained drive letter does not prove local: statfs.type is zero on Windows.
      return {
        driveType: /^(?:\\\\|\/\/)/.test(probe.realpath(parent))
          ? "network"
          : "unknown",
      };
    }
    const type = probe.statfs(parent).type >>> 0;
    if (probe.platform === "linux") {
      if (remoteLinux.has(type)) return { driveType: "network" };
      if (localLinux.has(type)) return { driveType: "local" };
      // FUSE's shared magic cannot distinguish sshfs from a local FUSE filesystem.
    } else if (probe.platform === "darwin" && type === 2) {
      // Node/libuv exposes f_type, not f_fstypename or MNT_LOCAL. NFS registers
      // VT_NFS (2); other drivers (e.g. SMB/APFS) may get dynamic IDs: leave unknown.
      // https://github.com/apple-oss-distributions/NFS/blob/main/kext/nfs_vfsops.c
      // https://github.com/apple-oss-distributions/xnu/blob/main/bsd/sys/vnode.h
      // https://github.com/libuv/libuv/blob/v1.x/src/unix/fs.c (uv__fs_statfs)
      return { driveType: "network" };
    }
  } catch {
    // An unavailable platform signal retains the existing unknown warning.
  }
  return { driveType: "unknown" };
}
