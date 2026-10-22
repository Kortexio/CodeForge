'use strict';

const fs = require('fs');
const path = require('path');

const COUPONS_FILE = path.join(__dirname, '..', '..', 'config', 'coupons.json');

function loadCoupons(file = COUPONS_FILE) {
	return JSON.parse(fs.readFileSync(file, 'utf8'));
}

module.exports = { COUPONS_FILE, loadCoupons };
