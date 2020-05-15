module.exports = (routeName) => {
    let rawNumber = parseInt(routeName.replace(/\D/g,''));
    let prefix = 'А';

    if (routeName.startsWith('Т')) {
        // tram or trol
        prefix = (rawNumber >= 20) ? 'Тр' : 'Т';
        
    } else if (routeName.startsWith('Н')) {
        // night bus
        prefix = 'Н-А'
    }

    return prefix + ((rawNumber > 10) ? rawNumber : ('0' + rawNumber));
}

