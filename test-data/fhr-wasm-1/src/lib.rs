//! A minimal fhr-wasm-1 handler (FHR SPEC §7) for ForgeHub's loader tests: no
//! Go, no build in the test run — `fixture.wasm` beside this file is its
//! `cargo build --release --target wasm32-unknown-unknown` output, committed.
//!
//! Its answers are fixed functions of the input lengths, so tests can predict
//! them. It writes one line to stderr through WASI on every diff and draws
//! random bytes, so a host's sandboxed WASI is exercised too. A diff whose head
//! is the four bytes `trap` hits an unreachable instruction, as a crashing
//! handler would.

#[link(wasm_import_module = "wasi_snapshot_preview1")]
extern "C" {
    fn fd_write(fd: u32, iovs: *const u32, iovs_len: u32, written: *mut u32) -> u32;
    fn random_get(buf: *mut u8, len: u32) -> u32;
}

fn give(v: Vec<u8>) -> u64 {
    let b = v.into_boxed_slice();
    let len = b.len() as u64;
    let ptr = Box::into_raw(b) as *mut u8 as u32 as u64;
    (ptr << 32) | len
}

#[no_mangle]
pub extern "C" fn fhr_alloc(size: u32) -> u32 {
    (give(vec![0u8; size as usize]) >> 32) as u32
}

#[no_mangle]
pub unsafe extern "C" fn fhr_free(ptr: u32, size: u32) {
    drop(Box::from_raw(std::ptr::slice_from_raw_parts_mut(ptr as *mut u8, size as usize)));
}

fn log(line: &str) {
    let iov = [line.as_ptr() as u32, line.len() as u32];
    let mut written = 0u32;
    unsafe { fd_write(2, iov.as_ptr(), 1, &mut written) };
}

fn reply(json: &str, blobs: &[&[u8]]) -> u64 {
    let lens: Vec<String> = blobs.iter().map(|b| b.len().to_string()).collect();
    let header = if blobs.is_empty() { json.to_string() } else { format!("{},\"blobs\":[{}]}}", &json[..json.len() - 1], lens.join(",")) };
    let mut out = (header.len() as u32).to_le_bytes().to_vec();
    out.extend_from_slice(header.as_bytes());
    for b in blobs {
        out.extend_from_slice(b);
    }
    give(out)
}

#[no_mangle]
pub unsafe extern "C" fn fhr_call(ptr: u32, size: u32) -> u64 {
    let req = std::slice::from_raw_parts(ptr as *const u8, size as usize);
    let n = u32::from_le_bytes([req[0], req[1], req[2], req[3]]) as usize;
    let header = std::str::from_utf8(&req[4..4 + n]).unwrap_or("");
    let lens: Vec<usize> = header
        .split("\"blobs\":[").nth(1)
        .and_then(|s| s.split(']').next())
        .map(|s| s.split(',').filter_map(|x| x.trim().parse().ok()).collect())
        .unwrap_or_default();
    let mut blobs = Vec::new();
    let mut at = 4 + n;
    for l in lens {
        blobs.push(&req[at..at + l]);
        at += l;
    }
    let op = header.split("\"op\":\"").nth(1).and_then(|s| s.split('"').next()).unwrap_or("");
    match (op, blobs.as_slice()) {
        ("info", []) => reply(r#"{"result":{"id":"fixture","formats":[".fx"],"protocol":"1.0","capabilities":{"semanticCompare":true,"semanticMerge":true},"preview":"model/gltf-binary"}}"#, &[]),
        ("diff", [_, b]) if *b == b"trap" => core::arch::wasm32::unreachable(),
        ("diff", [a, b]) => {
            let mut noise = [0u8; 8];
            random_get(noise.as_mut_ptr(), 8);
            log(&format!("fixture: diff {}+{} bytes\n", a.len(), b.len()));
            let changes = if a == b {
                String::new()
            } else {
                format!(r#"{{"path":"bytes","kind":"modified","label":"bytes","before":"{}","after":"{}"}}"#, a.len(), b.len())
            };
            reply(&format!(r#"{{"result":{{"version":"1.0","format":"fixture","changes":[{changes}]}}}}"#), &[])
        }
        ("merge", [_, ours, theirs]) => {
            let merged: Vec<u8> = ours.iter().chain(theirs.iter()).copied().collect();
            reply(&format!(r#"{{"result":{{"conflicts":[{{"path":"bytes","ours":{},"theirs":{}}}]}}}}"#, ours.len(), theirs.len()), &[&merged])
        }
        ("preview", [blob]) => {
            let reversed: Vec<u8> = blob.iter().rev().copied().collect();
            reply(r#"{"result":{"mediaType":"model/gltf-binary"}}"#, &[&reversed])
        }
        _ => reply(r#"{"error":"fixture: unknown call or wrong blobs"}"#, &[]),
    }
}
