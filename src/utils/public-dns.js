"use strict";

const dns = require("dns");
const net = require("net");
const ipaddr = require("ipaddr.js");
const SecurityLimitError = require("../model/security-limit-error");
const globalV6 = ipaddr.parse("2000::");

function isPublicAddress(address) {
    if (!net.isIP(address)) return false;
    const parsed = ipaddr.process(address);
    if (parsed.range() !== "unicast") return false;
    // Reject unallocated/special IPv6 space even when it has no named range.
    return parsed.kind() === "ipv4" || parsed.match(globalV6, 3);
}

function deniedAddress() {
    return new SecurityLimitError("The outbound hostname resolves to a non-public or invalid IP address.", {
        code: "OUTBOUND_ADDRESS_DENIED", status: 422
    });
}

/** Validate the exact DNS answers used to open the socket, without a second lookup. */
function createPublicLookup(resolve = dns.lookup) {
    return (hostname, options, callback) => {
        if (typeof options === "function") { callback = options; options = {}; }
        if (typeof options === "number") options = {family: options};
        options = options || {};
        resolve(hostname, {all: true, verbatim: true}, (error, records) => {
            if (error) return callback(error);
            if (!Array.isArray(records) || records.length === 0 || records.some(record =>
                !record || !isPublicAddress(record.address) || net.isIP(record.address) !== record.family)) {
                return callback(deniedAddress());
            }
            const family = options.family === "IPv4" ? 4 : options.family === "IPv6" ? 6 : options.family;
            const candidates = family ? records.filter(record => record.family === family) : records;
            if (candidates.length === 0) {
                return callback(Object.assign(new Error("No address for the requested IP family."), {code: "ENOTFOUND"}));
            }
            if (options.all) return callback(null, candidates);
            callback(null, candidates[0].address, candidates[0].family);
        });
    };
}

module.exports = {createPublicLookup, isPublicAddress};
