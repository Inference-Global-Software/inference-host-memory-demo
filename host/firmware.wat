;; A host program that shares one memory with the Inference module.
;;
;; It stands in for the C or Rust firmware a module like this is embedded in.
;; It imports the same memory the Inference module does and keeps to pages 2-4:
;; page 1 (bytes 0-65,535) belongs to the Inference module, whose stack and
;; constants live there. It never writes to page 1. It only reads the results
;; there that the module points it to.
;;
;; Its exports are exactly the host functions the Inference program imports
;; from `host::sensor`, so the page passes them to the module as they are, and
;; every call between the two programs goes straight from one to the other.
;;
;; Rebuild with: wat2wasm host/firmware.wat -o host/firmware.wasm
(module
  ;; At least 2 pages, since its own data lives in page 2; at most 4, the
  ;; ceiling the Inference module declares too.
  (import "env" "memory" (memory 2 4))

  ;; Its layout, all in page 2:
  ;;   65,536  how many readings it has
  ;;   65,540  the readings, one i32 each (degrees C)
  ;;   66,048  its copy of the module's results: count, lowest, highest, total
  ;;   66,064  its copy of the module's band counters
  ;;   66,080  how many calls it has answered
  ;;   66,084  the two addresses the module reported, results then counters
  (data (i32.const 65536) "\18\00\00\00")
  (data (i32.const 65540)
    "\0a\00\00\00\03\00\00\00\04\00\00\00\08\00\00\00\0b\00\00\00\0d\00\00\00"
    "\0d\00\00\00\0e\00\00\00\0b\00\00\00\13\00\00\00\0e\00\00\00\18\00\00\00"
    "\14\00\00\00\1b\00\00\00\17\00\00\00\12\00\00\00\16\00\00\00\19\00\00\00"
    "\1f\00\00\00\1e\00\00\00\1e\00\00\00\1d\00\00\00\1c\00\00\00\27\00\00\00")

  ;; sample_count() -> i32: how many readings the log holds.
  (func (export "sample_count") (result i32)
    (call $answered)
    (i32.load (i32.const 65536)))

  ;; sample(i) -> i32: reading i, from the log at 65,540 + 4 * i.
  (func (export "sample") (param $i i32) (result i32)
    (call $answered)
    (i32.load (i32.add (i32.const 65540) (i32.shl (local.get $i) (i32.const 2)))))

  ;; report(stats, histogram): the module passes two addresses in page 1.
  ;; Read the four numbers at each, and keep a copy in page 2.
  (func (export "report") (param $stats i32) (param $histogram i32)
    (call $answered)
    (i32.store (i32.const 66084) (local.get $stats))
    (i32.store (i32.const 66088) (local.get $histogram))
    (call $copy (local.get $stats) (i32.const 66048))
    (call $copy (local.get $histogram) (i32.const 66064)))

  ;; Four i32s from `from` to `to`.
  (func $copy (param $from i32) (param $to i32)
    (i32.store (local.get $to) (i32.load (local.get $from)))
    (i32.store offset=4 (local.get $to) (i32.load offset=4 (local.get $from)))
    (i32.store offset=8 (local.get $to) (i32.load offset=8 (local.get $from)))
    (i32.store offset=12 (local.get $to) (i32.load offset=12 (local.get $from))))

  ;; Count one more answered call.
  (func $answered
    (i32.store (i32.const 66080) (i32.add (i32.load (i32.const 66080)) (i32.const 1))))
)
