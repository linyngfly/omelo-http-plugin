'use strict'

const parseString = require('xml2js').parseString
const raw = require('raw-body')

module.exports = parse

function convertXml2Json(str, options) {
    return new Promise((resolve, reject) => {
        parseString(str,
            { explicitArray: false, ignoreAttrs: false },
            function (err, result) {
                if (err) {
                    reject(err);
                }
                else {
                    resolve(result);
                }
            });
    })
}

function parse(request, options) {
    options = Object.assign({
        limit: '1mb',
        encoding: 'utf8',
        xmlOptions: {}
    }, options)
    const len = request.headers['content-length']
    if (len) {
        options.length = len
    }
    return raw(request, options)
        .then(str => {
            return convertXml2Json(str, options.xmlOptions).catch(err => {
                err = typeof err === 'string' ? new Error(err) : err
                err.status = 400
                err.body = str
                throw err
            })
        })
}