export const allowances: {
  file: string;
  hash: string;
  namespace: string;
  entries: readonly (readonly [number, readonly string[], string])[];
}[] = [
  {
    file: "src/assembly/approval.ts",
    hash: "5e41447d36a1cffada86541b76d1b8a6a79426f6229cbd2847a569ad61341639",
    namespace: "forge/core-approvals",
    entries: [
      [92, ["request"], "Approval request id, outside work."],
      [
        138,
        ["request"],
        "Approval response updates its request, outside work.",
      ],
      [228, ["used"], "Approval consumption nonce, outside work."],
    ],
  },
  {
    file: "src/assembly/async-state-client.ts",
    hash: "5a29cc01f90f05358eb84597282357fb547def9c3ec67a910e31f7c24daa11af",
    namespace: "forge/work",
    entries: [
      [14, [], "Forwards the caller key without creating a family."],
      [16, [], "Forwards caller batch entries without creating a family."],
    ],
  },
  {
    file: "src/blocks/check/entry.cts",
    hash: "9195470a4e5601e5a8acc0dd357f49deb2bcbb27ca951db8241b0f4421acc82e",
    namespace: "forge/check",
    entries: [
      [
        749,
        ["runs/"],
        "Check receipt under the declared check state namespace.",
      ],
    ],
  },
  {
    file: "src/core/runtime/services.ts",
    hash: "8df7b8cfe00cc7a0f7ba86f221604d9f12a202f187b912bd6c02118f36fef52f",
    namespace: "forge/work",
    entries: [
      [427, [], "Revocable membrane forwards the caller key."],
      [
        449,
        ["cleanup"],
        "Owned finalizer key authorized as cleanup by assembly.",
      ],
    ],
  },
  {
    file: "src/blocks/work/bound-lane-state.ts",
    hash: "7afab50370ee21933824095db022b45408a57d50d5f6d642fb9d89a88a3a880f",
    namespace: "forge/work",
    entries: [
      [
        177,
        ["bound-lane"],
        "boundLaneKey serializes the project tuple and issue id.",
      ],
    ],
  },
  {
    file: "src/core/state/index.ts",
    hash: "3c4d9ed2cc8f9de732fcd5c903f7f542deca767c15d86924459694fb68788581",
    namespace: "forge/work",
    entries: [
      [
        1249,
        ["allocation"],
        "Owner forwards caller keys; the pinned owner also emits allocation floors.",
      ],
      [1251, [], "Owner forwards deletion of the caller key."],
      [1253, [], "Owner forwards caller batch entries."],
    ],
  },
  {
    file: "src/assembly/state-client.ts",
    hash: "0c3a6eb0f0575dc538513e2e2a206a91c4205d4e70128f2db62cf9a0b6a24c6d",
    namespace: "forge/work",
    entries: [
      [
        183,
        ["comment", "allocation"],
        "Accepted landing comment appends under comment and advances its floor.",
      ],
      [208, [], "Bound client forwards deletion of the caller key."],
      [225, [], "Bound client forwards the caller key."],
      [
        253,
        ["allocation"],
        "Bound numbered write forwards its prefix to the allocator.",
      ],
      [270, [], "Clones batch values while retaining caller keys."],
    ],
  },
  {
    file: "src/blocks/work/entry.cts",
    hash: "a3c350fd0986e6e971c5e37b543c65a36673cfdc96b3c1a70965c8ac7783e27c",
    namespace: "forge/work",
    entries: [
      [491, [], "Read fence forwards caller keys."],
      [
        583,
        [
          "issue",
          "autopilot",
          "autopilot-event",
          "autopilot-clock",
          "autopilot-ask",
          "autopilot-merge",
          "cleanup",
          "landing",
          "attempt",
          "evidence",
          "note",
          "slots",
          "participant",
        ],
        "persist callers and key builders are pinned by this full-file digest.",
      ],
      [
        608,
        ["comment", "link", "allocation"],
        "appendNext callers append comments and links and advance floors.",
      ],
      [
        700,
        [],
        "Read-only missing-dependency destructuring has an unknown parser type.",
      ],
      [
        5907,
        ["selection", "attempt"],
        "Batch selects a result and updates existing attempts.",
      ],
      [
        6127,
        ["issue", "reopen"],
        "Reopen batch updates the existing issue and adds reopen history.",
      ],
      [
        6471,
        ["comment", "allocation"],
        "Budgeted intent call appends a comment and advances its floor.",
      ],
    ],
  },
  {
    file: "src/assembly/cloud-lane-coordinator.ts",
    hash: "16d137928993ddbee582c4e3fda82dadc4c263e092d45c4007b8db3cdccfcbbd",
    namespace: "forge/work",
    entries: [
      [
        161,
        ["bound-lane"],
        "Rollback deletes the tuple key built by boundLaneKey.",
      ],
    ],
  },
  {
    file: "src/assembly/levels.ts",
    hash: "1600a68de0f4755b4fd775512023737e5964745d9c5e4326ef561bbce311b349",
    namespace: "forge/core-project",
    entries: [
      [
        276,
        ["identity"],
        "Mints project identity; namespace constant reviewed here.",
      ],
      [300, ["identity"], "Records project id beside its store identity."],
    ],
  },
  {
    file: "src/assembly/levels.ts",
    hash: "1600a68de0f4755b4fd775512023737e5964745d9c5e4326ef561bbce311b349",
    namespace: "forge/core-projects",
    entries: [
      [329, ["project/"], "Device project registry entry."],
      [349, ["project/"], "Deletes an obsolete device registry entry."],
    ],
  },
  {
    file: "src/assembly/index.ts",
    hash: "05df12f9b49a8dc27f8e036e51f157e56bbbe227ddc30888db65d575128e2752",
    namespace: "forge/core-trust",
    entries: [[333, ["digest"], "Trust digest writer, outside work."]],
  },
  {
    file: "src/core/trust/index.ts",
    hash: "fa042ce671212779211a9f7d710e1eecdd5125b34fec524793af9027eab4a875",
    namespace: "forge/core-trust",
    entries: [
      [
        65,
        ["digest"],
        "Trust store port deletes a captured proof digest, outside work.",
      ],
    ],
  },
  {
    file: "src/blocks/memory/index.cts",
    hash: "0d881b287ffecd7d10a10216e459303985a43168ffb5f45b740f3179e3593296",
    namespace: "forge/memory",
    entries: [
      [
        1056,
        ["note/", "meta/", "transfer/"],
        "Memory state binding and key builders are pinned by this full-file digest.",
      ],
      [
        1638,
        ["note/", "meta/", "transfer/"],
        "Memory state binding and key builders are pinned by this full-file digest.",
      ],
      [
        1693,
        ["note/", "meta/", "transfer/"],
        "Memory state binding and key builders are pinned by this full-file digest.",
      ],
      [
        1762,
        ["note/", "meta/", "transfer/"],
        "Memory state binding and key builders are pinned by this full-file digest.",
      ],
      [
        2111,
        ["note/", "meta/", "transfer/"],
        "Memory state binding and key builders are pinned by this full-file digest.",
      ],
      [
        2166,
        ["note/", "meta/", "transfer/"],
        "Memory state binding and key builders are pinned by this full-file digest.",
      ],
      [
        2177,
        ["note/", "meta/", "transfer/"],
        "Memory state binding and key builders are pinned by this full-file digest.",
      ],
      [
        2364,
        ["note/", "meta/", "transfer/"],
        "Memory state binding and key builders are pinned by this full-file digest.",
      ],
      [
        2410,
        ["note/", "meta/", "transfer/"],
        "Memory state binding and key builders are pinned by this full-file digest.",
      ],
      [
        2414,
        ["note/", "meta/", "transfer/"],
        "Memory state binding and key builders are pinned by this full-file digest.",
      ],
      [
        2561,
        ["note/", "meta/", "transfer/"],
        "Memory state binding and key builders are pinned by this full-file digest.",
      ],
      [
        2599,
        ["note/", "meta/", "transfer/"],
        "Memory state binding and key builders are pinned by this full-file digest.",
      ],
      [
        2940,
        ["note/", "meta/", "transfer/"],
        "Memory state binding and key builders are pinned by this full-file digest.",
      ],
      [
        3018,
        ["note/", "meta/", "transfer/"],
        "Memory state binding and key builders are pinned by this full-file digest.",
      ],
      [
        3163,
        ["meta/", "decision/", "decision-id/"],
        "Memory state binding and key builders are pinned by this full-file digest.",
      ],
      [
        3229,
        ["meta/", "decision/", "decision-id/"],
        "Memory state binding and key builders are pinned by this full-file digest.",
      ],
    ],
  },
];
