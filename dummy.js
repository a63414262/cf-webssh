// 终极黑洞 Proxy：无论怎么调用、怎么获取属性，都不会报错，完美骗过 ssh2 引擎
const dummy = new Proxy(function() {}, {
    get: function() { return dummy; },
    apply: function() { return dummy; },
    construct: function() { return dummy; }
});
module.exports = dummy;
