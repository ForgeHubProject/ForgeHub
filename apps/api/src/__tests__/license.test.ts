import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestRepo, makeCommit, type TestRepo } from "./helpers/git.js";
import { matchSpdx, detectRepoLicense, __resetLicenseCache } from "../license.js";

// Representative opening text for each license family (enough to key on).
const SAMPLES: Record<string, string> = {
  "MIT": `MIT License

Copyright (c) 2026 Foo Bar

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction.`,
  "Apache-2.0": `                                 Apache License
                           Version 2.0, January 2004
                        http://www.apache.org/licenses/

   TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION`,
  "GPL-3.0": `                    GNU GENERAL PUBLIC LICENSE
                       Version 3, 29 June 2007

 Copyright (C) 2007 Free Software Foundation, Inc.`,
  "GPL-2.0": `                    GNU GENERAL PUBLIC LICENSE
                       Version 2, June 1991

 Copyright (C) 1989, 1991 Free Software Foundation, Inc.`,
  "BSD-3-Clause": `Copyright (c) 2026, The Authors

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice.
2. Redistributions in binary form must reproduce the above copyright notice.
3. Neither the name of the copyright holder nor the names of its contributors
   may be used to endorse or promote products derived from this software.`,
  "BSD-2-Clause": `Copyright (c) 2026, The Authors

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice.
2. Redistributions in binary form must reproduce the above copyright notice.`,
  "MPL-2.0": `Mozilla Public License Version 2.0
==================================

1. Definitions`,
  "Unlicense": `This is free and unencumbered software released into the public domain.

Anyone is free to copy, modify, publish, use, compile, sell, or distribute this
software, either in source code form or as a compiled binary.`,
  "ISC": `ISC License

Copyright (c) 2026 Foo Bar

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted.`,
};

describe("matchSpdx (license keyword table)", () => {
  for (const [spdx, text] of Object.entries(SAMPLES)) {
    it(`recognizes ${spdx}`, () => {
      expect(matchSpdx(text)).toBe(spdx);
    });
  }

  it("recognizes a bare 'MIT License' header (truncated form)", () => {
    expect(matchSpdx("MIT License\n\nCopyright (c) 2026 Demo User\n")).toBe("MIT");
  });

  it("returns null for an unrecognized / proprietary license", () => {
    expect(matchSpdx("Copyright 2026 Acme Corp. All rights reserved.")).toBeNull();
    expect(matchSpdx("")).toBeNull();
  });

  it("distinguishes BSD-3-Clause from BSD-2-Clause by the endorsement clause", () => {
    expect(matchSpdx(SAMPLES["BSD-3-Clause"])).toBe("BSD-3-Clause");
    expect(matchSpdx(SAMPLES["BSD-2-Clause"])).toBe("BSD-2-Clause");
  });
});

describe("detectRepoLicense (tree read + match)", () => {
  let repo: TestRepo;

  beforeAll(async () => {
    repo = await createTestRepo("test/license.git");
    __resetLicenseCache();
  }, 30_000);

  afterAll(async () => {
    await repo.cleanup();
  });

  it("detects a top-level LICENSE file and its SPDX id", async () => {
    await makeCommit(repo.workDir, { "LICENSE": SAMPLES["MIT"], "readme.md": "# hi" }, "add MIT license");
    const result = await detectRepoLicense(repo.storageKey);
    expect(result).toEqual({ spdxId: "MIT", path: "LICENSE" });
  });

  it("returns null when there is no license file", async () => {
    const bare = await createTestRepo("test/no-license.git");
    try {
      await makeCommit(bare.workDir, { "readme.md": "# no license here" }, "init");
      expect(await detectRepoLicense(bare.storageKey)).toBeNull();
    } finally {
      await bare.cleanup();
    }
  });

  it("returns null for a missing storage key", async () => {
    expect(await detectRepoLicense(null)).toBeNull();
  });
});
